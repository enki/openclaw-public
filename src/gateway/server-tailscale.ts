import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "../infra/backoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isTailscaleRouteOwnershipConflictError } from "../infra/tailscale-route-ownership-error.js";
import { TailscaleServeDisabledError } from "../infra/tailscale-serve-disabled-error.js";
import {
  claimTailscaleRoute,
  getTailnetHostname,
  getTailnetHostnameAfterServe,
  hasTailscaleFunnelRouteForPort,
} from "../infra/tailscale.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import type { GatewayTailscaleIngressEndpoint } from "./ingress-attribution.js";
import { prepareTailscalePublishedOrigin } from "./tailscale-published-origin.js";

const RECLAIM_BACKOFF: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.2,
};

type ManagedTailscaleRoute = {
  claim: Awaited<ReturnType<typeof claimTailscaleRoute>>;
  clearPublishedOrigin?: () => void;
};

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  port: number;
  backend?: GatewayTailscaleIngressEndpoint;
  preserveFunnel?: boolean;
  controlUiBasePath?: string;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
  signal?: AbortSignal;
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }
  if (!params.backend) {
    throw new Error("Managed Tailscale ingress failed to start");
  }
  const backendTarget = params.backend.port;
  const effectiveMode = params.tailscaleMode;
  if (params.tailscaleMode === "serve" && params.preserveFunnel === true) {
    let preservedFunnel: boolean;
    try {
      preservedFunnel = await hasTailscaleFunnelRouteForPort(params.port);
    } catch (error) {
      params.logTailscale.warn(
        `serve not changed because external Funnel status could not be inspected: ${formatErrorMessage(error)}`,
      );
      throw error;
    }
    if (preservedFunnel) {
      params.logTailscale.warn(
        `external Tailscale Funnel for port ${params.port} remains active only for plugin-authenticated webhook routes; Gateway-authenticated routes reject its unattributable ingress. ` +
          "First configure a durable gateway password (gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD) and set gateway.auth.mode=password, " +
          "then run `openclaw config set gateway.tailscale.mode funnel` and `openclaw config unset gateway.tailscale.preserveFunnel`; " +
          "see https://docs.openclaw.ai/gateway/tailscale#public-internet-funnel-%2B-shared-password",
      );
      return null;
    }
  }

  const claimRoute = async (signal?: AbortSignal): Promise<ManagedTailscaleRoute> => {
    let claim: ManagedTailscaleRoute["claim"] | undefined;
    let clearPublishedOrigin: (() => void) | undefined;
    try {
      claim = await claimTailscaleRoute(
        effectiveMode,
        backendTarget,
        params.port,
        params.logTailscale.info,
        signal,
      );
      const hostname = (
        params.tailscaleMode === "serve" ? getTailnetHostnameAfterServe() : getTailnetHostname()
      ).catch((error: unknown) => {
        params.logTailscale.warn(
          `Could not read the Tailscale hostname; managed portal ingress is unavailable: ${formatErrorMessage(error)}`,
        );
        return null;
      });
      const host = await racePromiseWithAbortSignal(hostname, signal, (aborted) => aborted.reason);
      signal?.throwIfAborted();
      if (!claim.isActive()) {
        throw new Error(`Managed Tailscale ${params.tailscaleMode} claim exited during startup`);
      }
      if (host) {
        const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
        const publicHost = resolveTailscalePublishedHost({
          tailscaleMode: effectiveMode,
          tailnetHost: host,
        });
        if (publicHost) {
          clearPublishedOrigin = prepareTailscalePublishedOrigin({
            origin: `https://${publicHost}`,
            mode: effectiveMode,
          });
          params.logTailscale.info(
            `${params.tailscaleMode} enabled: https://${publicHost}${uiPath} (WS via wss://${publicHost})`,
          );
        } else {
          params.logTailscale.info(`${params.tailscaleMode} enabled`);
        }
      } else {
        params.logTailscale.info(`${params.tailscaleMode} enabled`);
      }
      return { claim, clearPublishedOrigin };
    } catch (err) {
      clearPublishedOrigin?.();
      try {
        await claim?.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [err, cleanupError],
          "Tailscale exposure startup and cleanup failed",
          { cause: cleanupError },
        );
      }
      signal?.throwIfAborted();
      throw err;
    }
  };

  let route: ManagedTailscaleRoute;
  try {
    route = await claimRoute(params.signal);
  } catch (err) {
    if (params.tailscaleMode === "serve" && err instanceof TailscaleServeDisabledError) {
      params.logTailscale.warn(
        "Tailscale Serve is not enabled on this tailnet. The authenticated local Gateway remains available on loopback; remote access is unavailable. Restore the intended tailnet Serve policy and restart the Gateway.",
      );
      return null;
    }
    params.logTailscale.warn(`${params.tailscaleMode} failed: ${formatErrorMessage(err)}`);
    throw err;
  }

  const recoveryAbort = new AbortController();
  // Startup retires after the close handle is published; cleanup owns the live route.
  const recoverySignal = recoveryAbort.signal;
  let reclaiming: Promise<void> | undefined;
  let recoveryFailure: AggregateError | undefined;
  const recoverRoute = async () => {
    for (let attempt = 1; !recoverySignal.aborted; attempt += 1) {
      try {
        await sleepWithAbort(computeBackoff(RECLAIM_BACKOFF, attempt), recoverySignal, {
          ref: false,
        });
        route = await claimRoute(recoverySignal);
        watchRoute(route);
        return;
      } catch (error) {
        if (error instanceof AggregateError) {
          // Unconfirmed claim cleanup must remain visible to the shutdown owner.
          recoveryFailure = error;
          params.logTailscale.warn(
            `${effectiveMode} recovery stopped because claim cleanup failed: ${formatErrorMessage(error)}`,
          );
          return;
        }
        if (recoverySignal.aborted) {
          return;
        }
        if (isTailscaleRouteOwnershipConflictError(error)) {
          params.logTailscale.warn(
            `${effectiveMode} recovery stopped because the HTTPS port is owned elsewhere: ${formatErrorMessage(error)}`,
          );
          return;
        }
        params.logTailscale.warn(
          `${effectiveMode} recovery failed; retrying: ${formatErrorMessage(error)}`,
        );
      }
    }
  };
  const watchRoute = (watched: ManagedTailscaleRoute) => {
    void watched.claim.exited.then(() => {
      watched.clearPublishedOrigin?.();
      if (recoverySignal.aborted) {
        return;
      }
      params.logTailscale.warn(
        `${effectiveMode} route claim exited; recovering managed Tailscale ingress`,
      );
      const pending = recoverRoute().finally(() => {
        if (reclaiming === pending) {
          reclaiming = undefined;
        }
      });
      reclaiming = pending;
    });
  };
  watchRoute(route);
  return async () => {
    route.clearPublishedOrigin?.();
    recoveryAbort.abort();
    await reclaiming;
    route.clearPublishedOrigin?.();
    await route.claim.stop();
    if (recoveryFailure) {
      throw recoveryFailure;
    }
  };
}
