"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { ApiError, fetcher, keys, settingsApi, type SaveModelsResult } from "@/lib/api";
import type { AIProviderKind, ModelInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";
import { FieldLabel, Input, Select } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { IconCheck, IconRefresh, IconX } from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/Confirm";
import { Divider, SettingsCard, maskPlaceholder, useSettingsPatch, type SectionProps } from "./common";

/** One line of "we tried it and this happened". */
function TestLine({ label, result }: { label: string; result: { ok: boolean; message: string } }) {
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-[12.5px] leading-snug",
        result.ok ? "text-ok" : "text-danger",
      )}
    >
      {result.ok ? (
        <IconCheck className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2.6} />
      ) : (
        <IconX className="mt-[2px] h-3.5 w-3.5 shrink-0" strokeWidth={2.6} />
      )}
      <span>
        <span className="font-medium">{label}:</span> {result.message}
      </span>
    </p>
  );
}

const PROVIDER_LABEL: Record<AIProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  custom: "Custom",
};

const PROVIDERS: AIProviderKind[] = ["openai", "anthropic", "gemini", "custom"];

/** An example id for the free-text box, in the provider's own naming. */
const MODEL_HINT: Record<AIProviderKind, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-4-argon",
  custom: "provider/model-id",
};

function markFor(ai: SectionProps["settings"]["ai"], kind: AIProviderKind) {
  return kind === "openai"
    ? ai.openaiKey
    : kind === "anthropic"
      ? ai.anthropicKey
      : kind === "gemini"
        ? ai.geminiKey
        : ai.customKey;
}

export function AiSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const toast = useToast();
  const confirm = useConfirm();
  const ai = settings.ai;
  const provider = ai.provider;
  const fallbackKeySet = ai.fallbackProvider ? markFor(ai, ai.fallbackProvider).set : false;
  const [baseUrl, setBaseUrl] = useState(ai.customBaseUrl);
  const [customModel, setCustomModel] = useState(ai.customModel);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Custom runs on its Model id when one is set (an older version could leave
  // it out of step with ai.model), so that is the model to show and to save.
  const savedModel = provider === "custom" ? ai.customModel || ai.model : ai.model;
  // An unpinned custom backup also uses that id, not its host's newest.
  const customBackupModel = ai.customModel.trim();

  // Draft choices, each re-seeded only when the saved setting it mirrors
  // changes — so a blur-save of the custom fields can't quietly throw away an
  // unsaved backup pick.
  const [draftModel, setDraftModel] = useState(savedModel);
  const [draftFallback, setDraftFallback] = useState<string>(ai.fallbackProvider);
  const [draftFallbackModel, setDraftFallbackModel] = useState(ai.fallbackModelPinned);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SaveModelsResult | null>(null);
  useEffect(() => {
    setDraftModel(savedModel);
  }, [savedModel, provider]);
  useEffect(() => {
    setDraftFallback(ai.fallbackProvider);
    setDraftFallbackModel(ai.fallbackModelPinned);
  }, [ai.fallbackProvider, ai.fallbackModelPinned]);
  // An unsaved backup on the provider just made active can't stand in for
  // it, so it gives way to what is saved. Any other unsaved pick is kept.
  useEffect(() => {
    if (draftFallback && draftFallback === provider) {
      setDraftFallback(ai.fallbackProvider);
      setDraftFallbackModel(ai.fallbackModelPinned);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);
  // The custom provider's own fields follow a save too, rather than sitting
  // there showing the old value.
  useEffect(() => {
    setCustomModel(ai.customModel);
  }, [ai.customModel]);
  useEffect(() => {
    setBaseUrl(ai.customBaseUrl);
  }, [ai.customBaseUrl]);

  // The backup provider's own catalogue, so its model can be picked by name.
  const { data: backupModelData, isLoading: backupModelsLoading } = useSWR<{ models: ModelInfo[] }>(
    draftFallback ? keys.models(draftFallback as AIProviderKind) : null,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const backupModels = backupModelData?.models ?? [];
  const backupPinMissing =
    !!draftFallbackModel && !backupModels.some((m) => m.id === draftFallbackModel);

  const {
    data: modelData,
    error: modelError,
    isLoading: modelsLoading,
    mutate: refreshModels,
  } = useSWR<{ models: ModelInfo[] }>(keys.models(provider), fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const models = modelData?.models ?? [];
  const modelsUnavailable = !!modelError;

  // A <select> whose value matches none of its options shows the first one
  // instead — which here reads "Auto — newest available", so a saved model the
  // provider no longer lists (or one that simply hasn't loaded yet) looked
  // exactly like the setting had been thrown away. Keep your pick in the list
  // whatever the provider says, and say so when the provider doesn't know it.
  const chosenMissing = !!draftModel && !models.some((m) => m.id === draftModel);
  const strayIsUnknown = chosenMissing && !modelsLoading && models.length > 0;

  // Nothing here writes until you press Save, so a half-made choice can't
  // quietly become the thing your work runs on.
  const dirty =
    draftModel !== savedModel ||
    draftFallback !== ai.fallbackProvider ||
    draftFallbackModel !== ai.fallbackModelPinned;

  const saveModels = async () => {
    setSaving(true);
    setSaved(null);
    try {
      const res = await settingsApi.saveModels({
        model: draftModel,
        fallbackProvider: draftFallback,
        fallbackModelPinned: draftFallbackModel,
      });
      setSaved(res);
      // What the server kept, which may differ from what was sent (a backup
      // on the active provider is turned off) even when nothing stored moved.
      setDraftModel(res.saved.model);
      setDraftFallback(res.saved.fallbackProvider);
      setDraftFallbackModel(res.saved.fallbackAuto ? "" : res.saved.fallbackModel);
      await mutate();
      toast.success(res.primary?.ok === false ? "Saved — but it didn't answer" : "Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save that");
    } finally {
      setSaving(false);
    }
  };

  const secretMark = markFor(ai, provider);
  const keyField =
    provider === "openai" ? "openaiKey" : provider === "anthropic" ? "anthropicKey" : "customKey";
  const envVar = secretMark.envVar ?? "";

  /** Deletes only the older copy the app itself stored; Railway's is untouched. */
  const deleteStoredCopy = async () => {
    const sure = await confirm({
      title: `Delete the ${PROVIDER_LABEL[provider]} key stored in the app?`,
      message:
        secretMark.source === "env"
          ? `Railway's ${envVar} is the one in use, so nothing changes — this just removes the old copy.`
          : `This copy is the one in use. Add ${envVar} in Railway first, or ${PROVIDER_LABEL[provider]} will stop working.`,
      confirmLabel: "Delete copy",
      destructive: true,
    });
    if (!sure) return;
    await patch({ ai: { [keyField]: "__clear__" } }, "Stored copy deleted");
  };

  const keyHistory = (settings.aiKeyLog ?? []).filter((e) => e.provider === provider).slice(0, 3);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await settingsApi.test(provider);
      setResult(res);
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof ApiError ? err.message : "Could not reach the provider",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsCard
      id="ai"
      title="AI model"
      description="Keys stay on your server — the browser never sees them."
    >
      <Segmented
        ariaLabel="AI provider"
        value={provider}
        onChange={(next) => {
          setResult(null);
          void patch({ ai: { provider: next } });
        }}
        options={PROVIDERS.map((p) => ({
          value: p,
          label: PROVIDER_LABEL[p],
        }))}
      />

      {/* Keys live in Railway's service variables now — the app only reports
          whether one is there, never takes one. */}
      <div className="rounded-2xl border border-stroke bg-sunken px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-muted">{PROVIDER_LABEL[provider]} API key</span>
          <span
            className={cn(
              "text-[12px] font-medium",
              secretMark.source === "env" ? "text-ok" : "text-danger",
            )}
          >
            {secretMark.source === "env" ? "Set in Railway" : "Not set"}
          </span>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          {secretMark.source === "env" ? (
            <>
              Read from <code className="font-mono text-[12px] text-ink">{envVar}</code> (ending{" "}
              {secretMark.last4}). To change it, edit that variable in Railway.
            </>
          ) : (
            <>
              In Railway, open your DoneX service → <span className="text-ink">Variables</span> → add{" "}
              <code className="font-mono text-[12px] text-ink">{envVar}</code> with your key. Railway
              redeploys on its own, and it shows up here.
            </>
          )}
        </p>
        {secretMark.storedCopy ? (
          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={() => void deleteStoredCopy()}>
              Delete the copy stored in the app
            </Button>
          </div>
        ) : null}
        {keyHistory.length > 0 ? (
          <p className="mt-1.5 text-[12px] leading-snug text-faint">
            {keyHistory
              .map((e) => `${e.action === "saved" ? "Saved" : "Removed"} ${relativeTime(e.at)}`)
              .join(" · ")}
          </p>
        ) : null}
        {!secretMark.set && ai.fallbackProvider && ai.fallbackProvider !== provider ? (
          <p className="mt-1.5 text-[12px] leading-snug text-warn">
            No {PROVIDER_LABEL[provider]} key — your {PROVIDER_LABEL[ai.fallbackProvider]} backup is doing
            all the work until you add one.
          </p>
        ) : null}
      </div>

      {provider === "custom" ? (
        <div className="space-y-3">
          <Input
            label="Base URL"
            placeholder="https://openrouter.ai/api/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => baseUrl !== ai.customBaseUrl && patch({ ai: { customBaseUrl: baseUrl } })}
          />
          <Input
            label="Model id"
            placeholder="meta-llama/llama-3.1-70b-instruct"
            value={customModel}
            onChange={(e) => {
              // This box and the model picker are one setting for Custom, so
              // a Save pressed straight from here sends what was typed.
              setCustomModel(e.target.value);
              setDraftModel(e.target.value);
            }}
            // The server moves ai.model with it while custom is the provider.
            // Sending model too could land it on another provider's pick if a
            // provider switch is saved first.
            onBlur={() => customModel !== ai.customModel && patch({ ai: { customModel } })}
          />
        </div>
      ) : null}

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[13px] font-medium text-muted">Model</span>
          <IconButton label="Refresh model list" size="sm" onClick={() => void refreshModels()}>
            <IconRefresh className={cn("h-4 w-4", modelsLoading && "animate-spin")} />
          </IconButton>
        </div>

        {modelsUnavailable || (!modelsLoading && models.length === 0) ? (
          <>
            <Input
              placeholder={MODEL_HINT[provider]}
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
            />
            <p className="mt-1.5 text-[12px] text-faint">
              Couldn’t list models — type the id yourself, or leave blank to auto-pick.
            </p>
          </>
        ) : (
          <>
            <Select
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              disabled={modelsLoading}
            >
              <option value="">Auto — newest available</option>
              {chosenMissing ? (
                <option value={draftModel}>
                  {draftModel}
                  {strayIsUnknown ? " — not in this provider's list" : ""}
                </option>
              ) : null}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
            {strayIsUnknown ? (
              <p className="mt-1.5 text-[12px] leading-snug text-warn">
                {PROVIDER_LABEL[provider]} didn’t list{" "}
                <span className="font-medium">{draftModel}</span>. It is still what DoneX
                asks for — pick another if it has been retired, since calls to a model the
                provider won’t serve fall through to your backup model.
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" loading={testing} onClick={test}>
          Test connection
        </Button>
        {result ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[13px]",
              result.ok ? "text-ok" : "text-danger",
            )}
          >
            {result.ok ? (
              <IconCheck className="h-4 w-4" strokeWidth={2.6} />
            ) : (
              <IconX className="h-4 w-4" strokeWidth={2.6} />
            )}
            {result.message}
          </span>
        ) : null}
      </div>

      <Divider />

      <div>
        <FieldLabel>Backup model</FieldLabel>
        <p className="mb-2 text-[13px] leading-relaxed text-muted">
          If {PROVIDER_LABEL[provider]} fails — expired key, rate limit, outage — DoneX
          retries the same request elsewhere instead of giving up. Pick the provider, and
          the model on it, or leave the model on auto to follow whatever is newest there.
        </p>
        <div className="flex gap-2">
          <Select
            value={draftFallback}
            onChange={(e) => {
              setDraftFallback(e.target.value);
              // That model id belonged to the provider you just left.
              setDraftFallbackModel("");
            }}
          >
            <option value="">No backup</option>
            {PROVIDERS
              // A standby on the active provider can't stand in for it, so it
              // is not offered — but if one is somehow set, it is still shown
              // rather than silently reading back as "No backup".
              .filter((k) => k !== provider || k === draftFallback)
              .map((k) => (
                <option key={k} value={k}>
                  {PROVIDER_LABEL[k]}
                  {k === provider ? " — same as the active one" : ""}
                </option>
              ))}
          </Select>
        </div>

        {draftFallback ? (
          <div className="mt-2">
            <Select
              value={draftFallbackModel}
              onChange={(e) => setDraftFallbackModel(e.target.value)}
              disabled={backupModelsLoading}
            >
              <option value="">
                {draftFallback === "custom" && customBackupModel
                  ? `Auto — the Custom model id (${customBackupModel})`
                  : `Auto — newest ${PROVIDER_LABEL[draftFallback as AIProviderKind]} model`}
              </option>
              {backupPinMissing ? (
                <option value={draftFallbackModel}>
                  {draftFallbackModel}
                  {!backupModelsLoading && backupModels.length > 0
                    ? " — not in this provider's list"
                    : ""}
                </option>
              ) : null}
              {backupModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
            <p className="mt-1.5 text-[12px] leading-snug text-faint">
              {draftFallbackModel
                ? "Pinned — failover uses exactly this, and won't move you off it."
                : draftFallback === "custom" && customBackupModel
                  ? "Uses the model id set for Custom."
                  : "Follows whatever is newest there, re-checked daily."}
            </p>
          </div>
        ) : null}

        {ai.fallbackProvider && !fallbackKeySet ? (
          <p className="mt-2 text-[12px] leading-snug text-warn">
            The backup has no key — add {markFor(ai, ai.fallbackProvider).envVar} in Railway →
            Variables, or it can’t run.
          </p>
        ) : null}

        {settings.aiFallback ? (
          <p className="mt-2 rounded-xl bg-sunken px-3 py-2 text-[12px] leading-snug text-muted">
            Last used {relativeTime(settings.aiFallback.at)} — {settings.aiFallback.model}{" "}
            covered for {PROVIDER_LABEL[settings.aiFallback.from]}, which said:{" "}
            “{settings.aiFallback.reason}”
          </p>
        ) : null}
      </div>

      <Divider />

      {/* One explicit write for both choices, so "saved" is a thing that
          happened at a moment you chose rather than something to take on
          trust. What is actually in force is spelled out either way. */}
      <div>
        <div className="rounded-2xl border border-stroke bg-sunken px-3.5 py-3">
          <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
            In use right now
          </div>
          <div className="mt-1 text-[13.5px] leading-relaxed text-ink">
            {PROVIDER_LABEL[ai.provider]} ·{" "}
            <span className="font-medium">{savedModel || "newest available (auto)"}</span>
          </div>
          <div className="mt-0.5 text-[13px] leading-relaxed text-muted">
            {ai.fallbackProvider
              ? `Backup: ${PROVIDER_LABEL[ai.fallbackProvider]}${
                  ai.fallbackModel ? ` · ${ai.fallbackModel}` : ""
                }${
                  ai.fallbackModelPinned
                    ? " (pinned)"
                    : ai.fallbackProvider === "custom" && customBackupModel
                      ? ""
                      : " (newest)"
                }`
              : "No backup"}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void saveModels()}>
            {dirty ? "Save and test" : "Saved"}
          </Button>
          {dirty ? (
            <span className="text-[13px] text-warn">Not saved yet</span>
          ) : null}
        </div>

        {saved ? (
          <div className="mt-3 space-y-1.5 rounded-2xl border border-stroke px-3.5 py-3">
            <p className="text-[13.5px] font-medium text-ink">
              Saved — {PROVIDER_LABEL[provider]} ·{" "}
              {saved.saved.model || "newest available (auto)"}
              {saved.saved.fallbackProvider
                ? `, backing up to ${PROVIDER_LABEL[saved.saved.fallbackProvider as AIProviderKind]}${
                    saved.saved.fallbackModel ? ` · ${saved.saved.fallbackModel}` : ""
                  }${
                    !saved.saved.fallbackAuto
                      ? " (pinned)"
                      : saved.saved.fallbackProvider === "custom" && customBackupModel
                        ? ""
                        : " (newest)"
                  }`
                : ", no backup"}
              .
            </p>
            {saved.note ? <p className="text-[12.5px] text-warn">{saved.note}</p> : null}
            {saved.primary ? <TestLine label="Main" result={saved.primary} /> : null}
            {saved.backup ? <TestLine label="Backup" result={saved.backup} /> : null}
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}
