"use client"

import * as React from "react"
import { IconInfoCircle } from "@tabler/icons-react"
import { cn } from "@/lib/utils"

export function InfoStrip({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800",
        className
      )}
    >
      <IconInfoCircle className="h-5 w-5 shrink-0 mt-0.5 text-blue-500" aria-hidden="true" />
      <div className="text-blue-800">{children}</div>
    </div>
  )
}