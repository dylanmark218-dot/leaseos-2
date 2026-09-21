import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Mic,
  Paperclip,
  Send,
  ShieldCheck,
  Sparkles,
  User,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

/** Message type matching the server-side LLM Message interface. */
export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AIChatBoxProps = {
  messages: Message[];
  onSendMessage: (content: string) => void;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  height?: string | number;
  emptyStateMessage?: string;
  suggestedPrompts?: string[];

  /** Optional LeaseOS context. All new props are backward-compatible. */
  contextLabel?: string;
  contextMeta?: string;
  assistantLabel?: string;
  syncState?: "synced" | "offline" | "syncing";
  reviewCount?: number;
  onReview?: () => void;
  onVoice?: () => void;
  onAttach?: () => void;
  onCamera?: () => void;
  showAssurance?: boolean;
};

const syncCopy = {
  synced: { label: "Synced", Icon: Wifi },
  offline: { label: "Offline · saved locally", Icon: WifiOff },
  syncing: { label: "Syncing", Icon: Loader2 },
} as const;

/**
 * LeaseOS Assistant conversation surface.
 *
 * Redesign goals:
 * - Context-first rather than generic consumer chat.
 * - Voice/photo/attachment controls are first-class.
 * - Review/commit is visible and separate from conversation.
 * - The AI is framed as a drafting assistant; users approve record changes.
 * - Existing Message[] and onSendMessage API remain intact.
 */
export function AIChatBox({
  messages,
  onSendMessage,
  isLoading = false,
  placeholder = "Tell LeaseOS what happened, ask a question, or type a note…",
  className,
  height = "680px",
  emptyStateMessage = "What would you like to do?",
  suggestedPrompts = [
    "Log this stop",
    "Report a defect",
    "Find a document",
    "Check what is still missing",
  ],
  contextLabel = "Current job",
  contextMeta = "No job context selected",
  assistantLabel = "LeaseOS Assistant",
  syncState = "synced",
  reviewCount = 0,
  onReview,
  onVoice,
  onAttach,
  onCamera,
  showAssurance = true,
}: AIChatBoxProps) {
  const [input, setInput] = useState("");
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const displayMessages = messages.filter(message => message.role !== "system");
  const SyncIcon = syncCopy[syncState].Icon;

  const scrollToBottom = () => {
    const viewport = scrollAreaRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null;
    if (!viewport) return;
    requestAnimationFrame(() => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    });
  };

  useEffect(() => {
    scrollToBottom();
  }, [displayMessages.length, isLoading]);

  const submitText = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || isLoading) return;
    onSendMessage(trimmed);
    setInput("");
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    submitText(input);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitText(input);
    }
  };

  return (
    <section
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-[12px] border border-[#dfe5ec] bg-white text-[#17212b] shadow-[0_8px_30px_rgba(32,54,78,0.06)]",
        className
      )}
      style={{ height }}
      aria-label={assistantLabel}
    >
      {/* Context + trust header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-[#e3e8ee] bg-[#fbfcfd] px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-[9px] border border-[#dbe3ec] bg-white text-[#2f6feb]">
            <Sparkles className="size-[18px]" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
                {assistantLabel}
              </h2>
              <span className="inline-flex items-center gap-1 rounded-full bg-[#2f8f6b14] px-2 py-0.5 text-[11px] font-semibold text-[#2f8f6b]">
                <ShieldCheck className="size-3" /> Drafts only
              </span>
            </div>
            <p className="truncate text-[12.5px] text-[#667481]">
              <span className="font-medium text-[#44515e]">
                {contextLabel}:
              </span>{" "}
              {contextMeta}
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span
            className={cn(
              "hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium sm:inline-flex",
              syncState === "offline"
                ? "bg-[#d9902614] text-[#b87210]"
                : "bg-[#71809614] text-[#667481]"
            )}
          >
            <SyncIcon
              className={cn(
                "size-3.5",
                syncState === "syncing" && "animate-spin"
              )}
            />
            {syncCopy[syncState].label}
          </span>

          {reviewCount > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={onReview}
              className="h-9 rounded-[7px] border-[#d9902640] bg-[#d990260e] px-3 text-[12.5px] font-semibold text-[#9a6418] hover:bg-[#d9902618]"
            >
              <AlertTriangle className="size-3.5" />
              Review {reviewCount}
              <ChevronRight className="size-3.5" />
            </Button>
          )}
        </div>
      </header>

      {/* Conversation */}
      <div
        ref={scrollAreaRef}
        className="min-h-0 flex-1 overflow-hidden bg-[#f8fafc]"
      >
        {displayMessages.length === 0 ? (
          <div className="flex h-full flex-col justify-center px-4 py-8 sm:px-8">
            <div className="mx-auto w-full max-w-[700px]">
              <div className="mb-6">
                <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#8996a5]">
                  Job-aware assistant
                </p>
                <h3 className="mt-2 text-[24px] font-semibold tracking-[-0.035em] text-[#17212b]">
                  {emptyStateMessage}
                </h3>
                <p className="mt-2 max-w-[58ch] text-[14px] leading-6 text-[#667481]">
                  Speak naturally or choose a common task. LeaseOS can draft
                  fields and paperwork, but record changes stay pending until
                  you review them.
                </p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {suggestedPrompts.map(prompt => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => submitText(prompt)}
                    disabled={isLoading}
                    className="group flex min-h-[52px] items-center justify-between rounded-[9px] border border-[#dfe5ec] bg-white px-4 py-3 text-left text-[13.5px] font-medium text-[#263442] transition hover:border-[#b8c6d6] hover:shadow-[0_4px_14px_rgba(32,54,78,0.05)] disabled:opacity-50"
                  >
                    <span>{prompt}</span>
                    <ChevronRight className="size-4 text-[#93a0ad] transition-transform group-hover:translate-x-0.5" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
              {displayMessages.map((message, index) => (
                <article
                  key={`${message.role}-${index}`}
                  className={cn(
                    "flex gap-3",
                    message.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  {message.role === "assistant" && (
                    <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-[#dce4ed] bg-white text-[#2f6feb]">
                      <Sparkles className="size-4" />
                    </div>
                  )}

                  <div
                    className={cn(
                      "max-w-[88%] text-[14px] leading-6 sm:max-w-[78%]",
                      message.role === "user"
                        ? "rounded-[12px_12px_3px_12px] bg-[#17324d] px-4 py-2.5 text-white"
                        : "rounded-[3px_12px_12px_12px] border border-[#e0e6ec] bg-white px-4 py-3 text-[#263442] shadow-[0_2px_8px_rgba(32,54,78,0.035)]"
                    )}
                  >
                    {message.role === "assistant" ? (
                      <div className="prose prose-sm max-w-none prose-headings:text-[#17212b] prose-p:my-1 prose-p:text-[#263442] prose-li:text-[#263442] prose-strong:text-[#17212b]">
                        <Streamdown>{message.content}</Streamdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    )}
                  </div>

                  {message.role === "user" && (
                    <div className="mt-1 hidden size-8 shrink-0 items-center justify-center rounded-[8px] border border-[#dce4ed] bg-white text-[#667481] sm:flex">
                      <User className="size-4" />
                    </div>
                  )}
                </article>
              ))}

              {isLoading && (
                <div className="flex items-start gap-3" aria-live="polite">
                  <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-[#dce4ed] bg-white text-[#2f6feb]">
                    <Sparkles className="size-4" />
                  </div>
                  <div className="flex items-center gap-2 rounded-[3px_12px_12px_12px] border border-[#e0e6ec] bg-white px-4 py-3 text-[13px] text-[#667481]">
                    <Loader2 className="size-4 animate-spin" />
                    Working from the current job context…
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Composer */}
      <footer className="border-t border-[#e1e7ed] bg-white px-3 py-3 sm:px-4">
        <form onSubmit={handleSubmit} className="mx-auto max-w-[860px]">
          <div className="flex items-end gap-2 rounded-[11px] border border-[#cfd8e3] bg-white p-2 shadow-[0_4px_18px_rgba(32,54,78,0.05)] focus-within:border-[#2f6feb] focus-within:ring-4 focus-within:ring-[#2f6feb12]">
            <div className="hidden items-center gap-1 sm:flex">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onCamera}
                className="size-9 rounded-[7px] text-[#667481] hover:bg-[#f0f3f6] hover:text-[#17212b]"
                aria-label="Add photo"
              >
                <Camera className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onAttach}
                className="size-9 rounded-[7px] text-[#667481] hover:bg-[#f0f3f6] hover:text-[#17212b]"
                aria-label="Attach document"
              >
                <Paperclip className="size-4" />
              </Button>
            </div>

            <Textarea
              ref={textareaRef}
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              className="max-h-32 min-h-10 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-[14px] leading-5 shadow-none placeholder:text-[#8a98a7] focus-visible:ring-0"
            />

            <Button
              type="button"
              onClick={onVoice}
              className="size-10 shrink-0 rounded-[9px] bg-[#17324d] p-0 text-white hover:bg-[#214566]"
              aria-label="Talk to LeaseOS"
            >
              <Mic className="size-[18px]" />
            </Button>

            <Button
              type="submit"
              size="icon"
              disabled={!input.trim() || isLoading}
              className="size-10 shrink-0 rounded-[9px] bg-[#2f6feb] hover:bg-[#285fc9] disabled:bg-[#dfe5ec] disabled:text-[#93a0ad]"
              aria-label="Send message"
            >
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </div>

          <div className="mt-2 flex min-h-5 flex-wrap items-center justify-between gap-2 px-1 text-[11.5px] text-[#7a8794]">
            <span className="inline-flex items-center gap-1.5 sm:hidden">
              <SyncIcon
                className={cn(
                  "size-3.5",
                  syncState === "syncing" && "animate-spin"
                )}
              />
              {syncCopy[syncState].label}
            </span>
            {showAssurance && (
              <span className="ml-auto inline-flex items-center gap-1.5">
                <CheckCircle2 className="size-3.5 text-[#2f8f6b]" />
                You review before records change
              </span>
            )}
          </div>
        </form>
      </footer>
    </section>
  );
}
