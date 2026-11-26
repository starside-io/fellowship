import { useEffect, useSyncExternalStore } from "react";
import { ArrowUpCircle } from "lucide-react";

import { host, type InstallResult, type UpdateStatus } from "@/client";
import { SectionCard, StatRow } from "@/ds/index";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Label } from "@/ui/label";

/**
 * The plugin update check: a button in the rail when a newer release is out,
 * and the switch for it in Settings. Both read one shared state, so turning
 * the check on in Settings shows the rail button without a reload, and an
 * install started from either place shows in both.
 *
 * The check is off until the owner turns it on, and while it is off the host
 * makes no request at all.
 */

interface UpdatesState {
  status: UpdateStatus | null;
  installing: boolean;
  result: InstallResult | null;
  checking: boolean;
}

let state: UpdatesState = { status: null, installing: false, result: null, checking: false };
let loaded = false;
const listeners = new Set<() => void>();

function set(patch: Partial<UpdatesState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function load(refresh = false) {
  set({ checking: true });
  try {
    set({ status: await host.updates(refresh) });
  } catch {
    // A host that does not answer has nothing to offer.
  } finally {
    set({ checking: false });
  }
}

async function toggle(enabled: boolean) {
  set({ checking: true });
  try {
    set({ status: await host.setUpdates(enabled), result: null });
  } finally {
    set({ checking: false });
  }
}

async function install() {
  if (state.installing) return;
  set({ installing: true, result: null });
  let result: InstallResult;
  try {
    result = await host.installUpdate();
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      output: "",
      command: state.status?.command ?? null,
    };
  }
  set({ installing: false, result });
  if (result.ok) await load();
}

function useUpdates(): UpdatesState {
  const current = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (loaded) return;
    loaded = true;
    void load();
  }, []);
  return current;
}

/** In the rail, only while there is something to say. */
export function UpdateButton() {
  const { status, installing, result } = useUpdates();
  const latest = status?.latest?.version;

  if (result?.ok) {
    return (
      <p className="text-positive px-1 text-xs">
        Fellowship is updated. Restart Claude Code to load it.
      </p>
    );
  }
  if (!status?.updateAvailable && !installing) return null;

  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={installing}
        onClick={() => void install()}
        className="hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-md border border-sidebar-border px-2.5 py-1.5 text-left text-sm disabled:opacity-60"
      >
        <ArrowUpCircle className="text-primary size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            {installing ? "Installing the update" : "Update available"}
          </span>
          <span className="text-muted-foreground block text-xs">
            {installing
              ? "This can take a minute."
              : `${status?.installed?.version ?? "?"} to ${latest ?? "?"}, click to install`}
          </span>
        </span>
      </button>
      {result && !result.ok ? <p className="text-negative px-1 text-xs">{result.message}</p> : null}
    </div>
  );
}

/** In Settings: the switch, what is installed, and what is out. */
export function UpdatesCard() {
  const { status, installing, result, checking } = useUpdates();

  const footer =
    status?.enabled && status.installed ? (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={checking || installing}
          onClick={() => void load(true)}
        >
          {checking ? "Checking" : "Check now"}
        </Button>
        {status.updateAvailable ? (
          <Button size="sm" disabled={installing} onClick={() => void install()}>
            {installing ? "Installing" : `Install ${status.latest?.version}`}
          </Button>
        ) : null}
        {result ? (
          <span className={result.ok ? "text-positive text-sm" : "text-negative text-sm"}>
            {result.message}
          </span>
        ) : null}
      </div>
    ) : undefined;

  return (
    <SectionCard
      title="Updates"
      description="Off until you turn it on. When it is on, the host asks GitHub once a day for the newest Fellowship release. Nothing about you or your people is sent."
      {...(footer ? { footer } : {})}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Checkbox
            id="update-check"
            checked={status?.enabled ?? false}
            disabled={status === null || checking}
            onCheckedChange={(value) => void toggle(value === true)}
          />
          <Label htmlFor="update-check">Check for plugin updates</Label>
        </div>

        <div className="space-y-1">
          <StatRow
            label="Installed"
            value={
              status?.installed ? (
                <span>
                  {status.installed.version}{" "}
                  <code className="text-muted-foreground text-xs">{status.installed.pluginId}</code>
                </span>
              ) : (
                "Not installed as a Claude Code plugin"
              )
            }
          />
          {status?.enabled && status.installed ? (
            <>
              <StatRow
                label="Latest release"
                value={
                  status.latest ? (
                    <a
                      href={status.latest.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      {status.latest.version}
                    </a>
                  ) : (
                    "None published yet"
                  )
                }
              />
              <StatRow
                label="Last checked"
                value={status.checkedAt ? new Date(status.checkedAt).toLocaleString() : "Never"}
              />
            </>
          ) : null}
        </div>

        {status?.error ? <p className="text-negative text-sm">{status.error}</p> : null}
        {result && !result.ok && result.output ? (
          <pre className="bg-muted max-h-48 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">
            {result.output}
          </pre>
        ) : null}
      </div>
    </SectionCard>
  );
}
