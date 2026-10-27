"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ApiError, authApi } from "@/lib/api";
import { forgetPushOnThisDevice } from "@/lib/pushClient";
import { Button } from "@/components/ui/Button";
import { PIN_MIN, PinPad } from "./PinPad";

export function LoginForm() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  // A device at the PIN pad has no session, so it should get no pushes. This
  // also catches one whose session ended without a sign-out here (revoked,
  // expired, or signed out before pushes followed sessions): once the browser
  // unsubscribes, the push service rejects the next send and the server
  // prunes the row.
  useEffect(() => {
    void forgetPushOnThisDevice();
  }, []);

  const submit = async () => {
    if (pin.length < PIN_MIN || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await authApi.login(pin);
      // A full load, not a client-side push: whatever an earlier session left
      // in memory (SWR's cache included) must not show for this one.
      window.location.replace(res.role === "partner" ? "/joint" : "/today");
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      // The server says how long the lockout is; it grows with each miss.
      if (status === 429) setError(err instanceof Error ? err.message : "Too many tries. Try again later.");
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
