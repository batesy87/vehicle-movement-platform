/**
 * The handful of primitives the phase-one screens need. Deliberately plain:
 * the product has no branding yet, so this is neutral rather than decorative,
 * and easy to replace wholesale once it does.
 */

import type { ComponentProps, ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-ink-200 bg-white p-6 shadow-sm dark:border-ink-700 dark:bg-ink-800 ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">{description}</p> : null}
    </header>
  );
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium">
      {children}
    </label>
  );
}

export function Input(props: ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 dark:border-ink-600 dark:bg-ink-900 ${props.className ?? ""}`}
    />
  );
}

export function Select(props: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={`w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 dark:border-ink-600 dark:bg-ink-900 ${props.className ?? ""}`}
    />
  );
}

export function Button({
  variant = "primary",
  ...props
}: ComponentProps<"button"> & { variant?: "primary" | "secondary" }) {
  const styles =
    variant === "primary"
      ? "bg-accent-600 text-white hover:bg-accent-700"
      : "border border-ink-300 hover:bg-ink-100 dark:border-ink-600 dark:hover:bg-ink-700";
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${styles} ${props.className ?? ""}`}
    />
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    >
      {message}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-ink-200 bg-ink-100 px-3 py-2 text-sm dark:border-ink-700 dark:bg-ink-800">
      {children}
    </p>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-ink-300 px-2 py-0.5 text-xs font-medium dark:border-ink-600">
      {children}
    </span>
  );
}
