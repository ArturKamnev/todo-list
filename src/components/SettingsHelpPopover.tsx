import { ExternalLink } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

type HelpLink = {
  label: string;
  url: string;
  ariaLabel?: string;
};

interface SettingsHelpPopoverProps {
  ariaLabel: string;
  title: string;
  children: ReactNode;
  links?: HelpLink[];
}

const popoverWidth = 328;
const popoverGap = 10;
const viewportPadding = 14;

export function SettingsHelpPopover({ ariaLabel, title, children, links = [] }: SettingsHelpPopoverProps) {
  const contentId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, originX: "50%", originY: "0%" });

  useLayoutEffect(() => {
    if (!open) return;

    const placePopover = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;

      const triggerRect = trigger.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const width = Math.min(popoverWidth, window.innerWidth - viewportPadding * 2);
      const height = popoverRect.height;
      const centeredLeft = triggerRect.left + triggerRect.width / 2 - width / 2;
      const left = clamp(centeredLeft, viewportPadding, window.innerWidth - width - viewportPadding);
      const hasRoomBelow = triggerRect.bottom + popoverGap + height <= window.innerHeight - viewportPadding;
      const top = hasRoomBelow
        ? triggerRect.bottom + popoverGap
        : Math.max(viewportPadding, triggerRect.top - popoverGap - height);
      const originX = `${clamp(triggerRect.left + triggerRect.width / 2 - left, 18, width - 18)}px`;

      setPosition({
        left,
        top,
        originX,
        originY: hasRoomBelow ? "0%" : "100%",
      });
    };

    placePopover();
    window.addEventListener("resize", placePopover);
    window.addEventListener("scroll", placePopover, true);
    return () => {
      window.removeEventListener("resize", placePopover);
      window.removeEventListener("scroll", placePopover, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function clearCloseTimer() {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }

  function scheduleClose() {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 120);
  }

  function handleBlur() {
    window.setTimeout(() => {
      const activeElement = document.activeElement;
      if (triggerRef.current?.contains(activeElement) || popoverRef.current?.contains(activeElement)) return;
      setOpen(false);
    }, 0);
  }

  function handleEscapeKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <span className="settings-help">
      <button
        ref={triggerRef}
        className="settings-help__trigger"
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? contentId : undefined}
        aria-haspopup="dialog"
        onBlur={handleBlur}
        onClick={() => setOpen((value) => !value)}
        onFocus={() => setOpen(true)}
        onKeyDown={handleEscapeKey}
        onMouseEnter={() => {
          clearCloseTimer();
          setOpen(true);
        }}
        onMouseLeave={scheduleClose}
      >
        ?
      </button>
      {open ? createPortal(
        <div
          ref={popoverRef}
          id={contentId}
          className="settings-help__popover"
          role="dialog"
          aria-labelledby={titleId}
          onBlur={handleBlur}
          onKeyDown={handleEscapeKey}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleClose}
          style={{
            left: position.left,
            top: position.top,
            maxWidth: `calc(100vw - ${viewportPadding * 2}px)`,
            transformOrigin: `${position.originX} ${position.originY}`,
          }}
        >
          <strong id={titleId}>{title}</strong>
          <div className="settings-help__content">{children}</div>
          {links.length ? (
            <div className="settings-help__links">
              {links.map((link) => (
                <button
                  className="settings-help__link"
                  key={link.url}
                  type="button"
                  aria-label={link.ariaLabel ?? link.label}
                  onClick={() => void window.todoAI?.openExternalLink(link.url)}
                >
                  <ExternalLink size={13} />
                  {link.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
