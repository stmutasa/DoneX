"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ApiError, authApi } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { PIN_MIN, PinPad } from "./PinPad";

export function LoginForm() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  const submit = async () => {
    if (pin.length < PIN_MIN || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await authApi.login(pin);
      router.push(res.role === "partner" ? "/joint" : "/today");
      router.refresh();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 429) setError("Too many tries. Take a breath — try again in a minute.");
      else if (status === 401) setError("That PIN doesn’t match.");
      else setError(err instanceof Error ? err.message : "Could not sign in");
      setPin("");
      setShake((s) => s + 1);
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-7 text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          Done<span className="text-sunrise">X</span>
        </h1>
        <p className="mt-1.5 text-[14px] text-muted">Welcome back.</p>
      </div>

      <motion.div
        key={shake}
        animate={shake ? { x: [0, -9, 8, -6, 4, 0] } : undefined}
        transition={{ duration: 0.42 }}
        className="card p-6"
      >
        <PinPad label="Enter PIN" value={pin} onChange={setPin} onSubmit={submit} />

        {error ? (
          <p className="mt-4 text-center text-[13px] font-medium text-danger">{error}</p>
        ) : null}

        <Button
          block
          variant="primary"
          size="lg"
          className="mt-6"
          loading={busy}
          disabled={pin.length < PIN_MIN}
          onClick={submit}
        >
          Unlock
        </Button>
      </motion.div>
    </div>
  );
}
