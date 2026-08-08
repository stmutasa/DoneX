"use client";

import { useState } from "react";
import useSWR from "swr";
import { ApiError, fetcher, keys, settingsApi } from "@/lib/api";
import type { AIProviderKind, ModelInfo } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { IconCheck, IconRefresh, IconX } from "@/components/ui/icons";
import { SettingsCard, maskPlaceholder, useSettingsPatch, type SectionProps } from "./common";

const PROVIDER_LABEL: Record<AIProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  custom: "Custom",
};

export function AiSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const ai = settings.ai;
  const provider = ai.provider;

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
    </SettingsCard>
  );
}
