'use client'

import * as React from 'react'
import { useState, useRef, useEffect, ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface TooltipProps {
  children: ReactNode | ((state: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode)
  delayDuration?: number
  skipDelayDuration?: number
}

interface TooltipTriggerProps {
  asChild?: boolean
  children: ReactNode
}

interface TooltipContentProps {
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  alignOffset?: number
  className?: string
}

export function Tooltip({ children, delayDuration = 700, skipDelayDuration = 300 }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMouseEnter = () => {
    if (skipTimeoutRef.current) {
      clearTimeout(skipTimeoutRef.current)
      skipTimeoutRef.current = null
    }
    timeoutRef.current = setTimeout(() => setOpen(true), delayDuration)
  }

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    skipTimeoutRef.current = setTimeout(() => setOpen(false), skipDelayDuration)
  }

  const child = typeof children === 'function' ? children({ open, onOpenChange: setOpen }) : React.Children.only(children)

  return (
    <div className="relative inline-block" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {child}
      {open && <TooltipArrow />}
    </div>
  )
}

function TooltipArrow() {
  return <div className="absolute z-10 rotate-45 size-2 bg-popover border-l-border border-t-border" />
}

export function TooltipTrigger({ asChild, children }: TooltipTriggerProps) {
  if (asChild) {
    return React.Children.only(children)
  }
  return <>{children}</>
}

export function TooltipContent({
  children,
  side = 'top',
  align = 'center',
  sideOffset = 4,
  alignOffset = 0,
  className,
}: TooltipContentProps) {
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const contentRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const trigger = triggerRef.current?.firstChild as HTMLElement
    const content = contentRef.current
    if (!trigger || !content) return

    const triggerRect = trigger.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()

    let x = 0
    let y = 0

    switch (side) {
      case 'top':
        y = -contentRect.height - sideOffset
        x = triggerRect.width / 2 - contentRect.width / 2 + alignOffset
        break
      case 'bottom':
        y = triggerRect.height + sideOffset
        x = triggerRect.width / 2 - contentRect.width / 2 + alignOffset
        break
      case 'left':
        x = -contentRect.width - sideOffset
        y = triggerRect.height / 2 - contentRect.height / 2 + alignOffset
        break
      case 'right':
        x = triggerRect.width + sideOffset
        y = triggerRect.height / 2 - contentRect.height / 2 + alignOffset
        break
    }

    switch (align) {
      case 'start':
        x = 0
        break
      case 'end':
        x = triggerRect.width - contentRect.width
        break
    }

    setPosition({ x, y })
  }, [side, align, sideOffset, alignOffset])

  return (
    <div
      ref={triggerRef}
      className="relative inline-block"
    >
      <div
        ref={contentRef}
        style={{
          position: 'absolute',
          left: position.x,
          top: position.y,
          zIndex: 50,
          pointerEvents: 'none',
        }}
      >
        <div
          className={cn(
            'absolute z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md',
            'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}