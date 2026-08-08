"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { authApi } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { PIN_MIN, PinPad } from "./PinPad";

export function SetupForm() {
  const router = useRouter();
  const [step, setStep] = useState<"create" | "confirm">("create");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tz, setTz] = useState("UTC");

  useEffect(() => {
    try {
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    } catch {
      setTz("UTC");
    }
  }, []);

  const next = () => {
    if (pin.length < PIN_MIN) return;
    setError("");
    setStep("confirm");
  };

  const finish = async () => {
    if (confirmPin !== pin) {
      setError("Those don’t match. Try once more.");
      setConfirmPin("");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await authApi.setup(pin, tz);
      router.push("/today");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="mb-8 text-center"
      >
        <div className="mb-3 text-5xl">🌅</div>
        <h1 className="text-4xl font-semibold tracking-tight text-ink">
          Done<span className="text-sunrise">X</span>
        </h1>
        <p className="mx-auto mt-2 max-w-[28ch] text-[15px] leading-relaxed text-muted">
          Your calm, AI-powered companion for everything you mean to get done.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="card p-6"
      >
        <h2 className="text-center text-[17px] font-semibold tracking-tight text-ink">
          {step === "create" ? "Choose a PIN" : "Confirm your PIN"}
        </h2>
        <p className="mt-1 text-center text-[13px] text-muted">
          {step === "create" ? "4–8 digits. It’s the only lock on your data." : "One more time."}
        </p>

        <div className="mt-6">
          {step === "create" ? (
            <PinPad label="Create PIN" value={pin} onChange={setPin} onSubmit={next} />
          ) : (
            <PinPad
              label="Confirm PIN"
              value={confirmPin}
              onChange={setConfirmPin}
              onSubmit={finish}
            />
          )}
        </div>

        {error ? (
          <p className="mt-4 text-center text-[13px] font-medium text-danger">{error}</p>
        ) : null}

        <div className="mt-6 space-y-2">
          {step === "create" ? (
            <Button block variant="primary" size="lg" disabled={pin.length < PIN_MIN} onClick={next}>
              Continue
            </Button>
          ) : (
            <>
              <Button
                block
                variant="primary"
                size="lg"
                loading={busy}
                disabled={confirmPin.length < PIN_MIN}
                onClick={finish}
              >
                Start using DoneX
              </Button>
              <Button
                block
                variant="ghost"
                onClick={() => {
                  setStep("create");
                  setConfirmPin("");
                  setError("");
                }}
              >
                Back
              </Button>
            </>
          )}
        </div>

        <p className="mt-5 text-center text-[12px] text-faint">Time zone detected: {tz}</p>
      </motion.div>
    </div>
  );
}
