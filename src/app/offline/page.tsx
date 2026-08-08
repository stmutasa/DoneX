import type { Metadata } from "next";

export const metadata: Metadata = { title: "Offline · DoneX" };

export default function OfflinePage() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-bg px-6 text-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 h-[340px] w-[340px] -translate-x-1/2 rounded-full bg-sunrise opacity-[0.14] blur-[110px]"
      />
      <div className="relative">
        <div className="mb-4 text-5xl">🌙</div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Done<span className="text-sunrise">X</span> is offline
        </h1>
        <p className="mx-auto mt-2 max-w-[30ch] text-[15px] leading-relaxed text-muted">
          No connection right now. Your tasks are safe — this page will come back to life the moment
          you’re online.
        </p>
        <a
          href="/today"
          className="mt-6 inline-flex min-h-[44px] items-center rounded-2xl bg-sunrise px-5 text-sm font-medium text-on-accent"
        >
          Try again
        </a>
      </div>
    </div>
  );
}
