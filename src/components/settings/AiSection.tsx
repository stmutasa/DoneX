"use client";

import { useState } from "react";
import useSWR from "swr";
import { ApiError, fetcher, keys, settingsApi } from "@/lib/api";
import type { AIProviderKind, ModelInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/format";
import { Button, IconButton } from "@/components/ui/Button";
import { FieldLabel, Input, Select } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { IconCheck, IconRefresh, IconX } from "@/components/ui/icons";
import { Divider, SettingsCard, maskPlaceholder, useSettingsPatch, type SectionProps } from "./common";

const PROVIDER_LABEL: Record<AIProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  custom: "Custom",
};

export function AiSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const ai = settings.ai;
  const provider = ai.provider;
  const fallbackKeySet =
    ai.fallbackProvider === "openai"
      ? ai.openaiKey.set
      : ai.fallbackProvider === "anthropic"
        ? ai.anthropicKey.set
        : ai.fallbackProvider === "custom"
          ? ai.customKey.set
          : false;

  const [fallbackModelDraft, setFallbackModelDraft] = useState(ai.fallbackModel);
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(ai.customBaseUrl);
  const [customModel, setCustomModel] = useState(ai.customModel);
  const [modelDraft, setModelDraft] = useState(ai.model);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

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

  const secretMark =
    provider === "openai" ? ai.openaiKey : provider === "anthropic" ? ai.anthropicKey : ai.customKey;
  const keyField =
    provider === "openai" ? "openaiKey" : provider === "anthropic" ? "anthropicKey" : "customKey";

  const saveKey = async () => {
    if (!keyDraft.trim()) return;
    setSavingKey(true);
    const ok = await patch({ ai: { [keyField]: keyDraft.trim() } }, "Key saved");
    setSavingKey(false);
    if (ok) {
      setKeyDraft("");
      void refreshModels();
    }
  };

  const clearKey = async () => {
    const ok = await patch({ ai: { [keyField]: "__clear__" } }, "Key cleared");
    if (ok) setKeyDraft("");
  };

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
          setKeyDraft("");
          setResult(null);
          void patch({ ai: { provider: next } });
        }}
        options={(["openai", "anthropic", "custom"] as AIProviderKind[]).map((p) => ({
          value: p,
          label: PROVIDER_LABEL[p],
        }))}
      />

      <div>
        <Input
          label={`${PROVIDER_LABEL[provider]} API key`}
          hint={secretMark.set ? "Saved" : "Required"}
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={maskPlaceholder(secretMark, "sk-…")}
          onChange={(e) => setKeyDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveKey()}
        />
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="primary" loading={savingKey} disabled={!keyDraft.trim()} onClick={saveKey}>
            Save key
          </Button>
          {secretMark.set ? (
            <Button size="sm" variant="ghost" onClick={clearKey}>
              Clear
            </Button>
          ) : null}
        </div>
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
            onChange={(e) => setCustomModel(e.target.value)}
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
              placeholder="gpt-4o-mini"
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={() => modelDraft !== ai.model && patch({ ai: { model: modelDraft } })}
            />
            <p className="mt-1.5 text-[12px] text-faint">
              Couldn’t list models — type the id yourself, or leave blank to auto-pick.
            </p>
          </>
        ) : (
          <Select
            value={ai.model}
            onChange={(e) => void patch({ ai: { model: e.target.value } })}
            disabled={modelsLoading}
          >
            <option value="">Auto — newest available</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
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
          retries the same request here instead of giving up.
        </p>
        <div className="flex gap-2">
          <Select
            value={ai.fallbackProvider}
            onChange={(e) =>
              void patch(
                { ai: { fallbackProvider: e.target.value as typeof ai.fallbackProvider } },
                e.target.value ? "Backup provider set" : "Backup turned off",
              )
            }
          >
            <option value="">No backup</option>
            {(["openai", "anthropic", "custom"] as AIProviderKind[])
              .filter((k) => k !== provider)
              .map((k) => (
                <option key={k} value={k}>
                  {PROVIDER_LABEL[k]}
                </option>
              ))}
          </Select>
        </div>

        {ai.fallbackProvider ? (
          <div className="mt-2 space-y-2">
            <div className="flex gap-2">
              <Input
                value={fallbackModelDraft}
                placeholder="Model id, e.g. claude-fable-5"
                onChange={(e) => setFallbackModelDraft(e.target.value)}
                onBlur={() => {
                  if (fallbackModelDraft.trim() !== ai.fallbackModel) {
                    void patch(
                      { ai: { fallbackModel: fallbackModelDraft.trim() } },
                      "Backup model saved",
                    );
                  }
                }}
              />
            </div>
            {!fallbackKeySet ? (
              <p className="text-[12px] leading-snug text-warn">
                Add an {PROVIDER_LABEL[ai.fallbackProvider]} API key above (switch the
                provider, paste the key, switch back) — without one the backup can’t run.
              </p>
            ) : !ai.fallbackModel.trim() ? (
              <p className="text-[12px] leading-snug text-warn">
                Name the model to use, or the backup stays inactive.
              </p>
            ) : (
              <p className="text-[12px] leading-snug text-faint">
                Ready — {ai.fallbackModel} takes over automatically when needed.
              </p>
            )}
          </div>
        ) : null}

        {settings.aiFallback ? (
          <p className="mt-2 rounded-xl bg-sunken px-3 py-2 text-[12px] leading-snug text-muted">
            Last used {relativeTime(settings.aiFallback.at)} — {settings.aiFallback.model}{" "}
            covered for {PROVIDER_LABEL[settings.aiFallback.from]}, which said:{" "}
            “{settings.aiFallback.reason}”
          </p>
        ) : null}
      </div>
    </SettingsCard>
  );
}
