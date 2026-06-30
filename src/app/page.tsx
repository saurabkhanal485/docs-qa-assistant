'use client';

/**
 * M3 + M4 — Chat UI
 *
 * Features:
 *  - Streaming token-by-token responses
 *  - Citations rendered as clickable links below each assistant message
 *  - Refusal state: distinct visual treatment when the LLM says it can't answer
 *  - Multi-turn conversation (history sent to API on each request)
 *  - Auto-scroll to latest message
 *  - Keyboard submit (Enter) + shift-Enter for newlines
 */

import { useState, useRef, useEffect, KeyboardEvent } from 'react';

interface Citation {
  index: number;
  title: string | null;
  url: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  isStreaming?: boolean;
  isRefusal?: boolean;
}

const REFUSAL_SIGNALS = [
  "couldn't find",
  "cannot find",
  "don't have",
  "do not have",
  "not in the documentation",
  "not covered",
  "check https://fastapi.tiangolo.com",
];

function looksLikeRefusal(text: string): boolean {
  const lower = text.toLowerCase();
  return REFUSAL_SIGNALS.some((s) => lower.includes(s));
}

function UserBubble({ content }: { content: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
      <div
        style={{
          background: '#2563eb',
          color: '#fff',
          borderRadius: '18px 18px 4px 18px',
          padding: '10px 16px',
          maxWidth: '78%',
          fontSize: 15,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({ msg }: { msg: Message }) {
  const isRefusal = msg.isRefusal ?? looksLikeRefusal(msg.content);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 500 }}>FastAPI Docs Assistant</span>
        {msg.isStreaming && (
          <span style={{ fontSize: 11, color: '#9ca3af' }}>● thinking…</span>
        )}
      </div>
      <div
        style={{
          background: isRefusal ? '#fef3c7' : '#f3f4f6',
          border: isRefusal ? '1px solid #fcd34d' : '1px solid #e5e7eb',
          borderRadius: '4px 18px 18px 18px',
          padding: '10px 16px',
          maxWidth: '85%',
          fontSize: 15,
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: '#111827',
        }}
      >
        {msg.content || <span style={{ color: '#9ca3af' }}>▍</span>}
        {msg.isStreaming && msg.content && (
          <span style={{ opacity: 0.4 }}>▍</span>
        )}
      </div>
      {!msg.isStreaming && msg.citations && msg.citations.length > 0 && (
        <div style={{ marginTop: 8, paddingLeft: 4 }}>
          <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 4, fontWeight: 500 }}>
            Sources
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {msg.citations.map((c) => (
              <li key={c.url} style={{ marginBottom: 3 }}>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 13,
                    color: '#2563eb',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span style={{ color: '#9ca3af', fontSize: 11 }}>[{c.index}]</span>
                  {c.title || c.url}
                  <span style={{ color: '#d1d5db', fontSize: 11 }}>↗</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  const examples = [
    'How do I define path parameters in FastAPI?',
    'What is dependency injection in FastAPI?',
    'How do I add authentication with OAuth2?',
    'How do I return a custom HTTP status code?',
  ];
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 40, marginBottom: 12 }}>📚</div>
      <h2 style={{ fontSize: 22, fontWeight: 600, color: '#111827', margin: '0 0 8px' }}>
        FastAPI Docs Q&A
      </h2>
      <p style={{ fontSize: 15, color: '#6b7280', maxWidth: 380, margin: '0 0 32px' }}>
        Ask anything about FastAPI — answers come directly from the official
        docs, with citations so you can verify.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 440 }}>
        {examples.map((ex) => (
          <button
            key={ex}
            onClick={() =>
              window.dispatchEvent(new CustomEvent('qa:example', { detail: ex }))
            }
            style={{
              background: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: 10,
              padding: '10px 16px',
              fontSize: 14,
              color: '#374151',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      setInput(text);
      textareaRef.current?.focus();
    };
    window.addEventListener('qa:example', handler);
    return () => window.removeEventListener('qa:example', handler);
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [input]);

  async function handleSubmit() {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = { role: 'user', content: trimmed };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    const assistantPlaceholder: Message = {
      role: 'assistant',
      content: '',
      isStreaming: true,
    };
    setMessages((prev) => [...prev, assistantPlaceholder]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok || !res.body) throw new Error(`API error: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let citations: Citation[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as
              | { token: string }
              | { citations: Citation[] }
              | { done: boolean }
              | { error: string };

            if ('error' in parsed) throw new Error(parsed.error);
            if ('token' in parsed) {
              accumulated += parsed.token;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: accumulated,
                };
                return updated;
              });
            }
            if ('citations' in parsed) citations = parsed.citations;
          } catch { /* skip malformed lines */ }
        }
      }

      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: accumulated,
          citations,
          isStreaming: false,
          isRefusal: looksLikeRefusal(accumulated),
        };
        return updated;
      });
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: `Something went wrong: ${(err as Error).message}`,
          isStreaming: false,
          isRefusal: true,
        };
        return updated;
      });
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        maxWidth: 760,
        margin: '0 auto',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#111827',
      }}
    >
      {/* Top bar */}
      <div
        style={{
          borderBottom: '1px solid #e5e7eb',
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: '#fff',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 20 }}>📚</span>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>FastAPI Docs Q&A</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            Answers grounded in{' '}
            <a
              href="https://fastapi.tiangolo.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#2563eb', textDecoration: 'none' }}
            >
              fastapi.tiangolo.com
            </a>
          </div>
        </div>
      </div>

      {/* Message list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '24px 24px 8px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map((msg, i) =>
            msg.role === 'user' ? (
              <UserBubble key={i} content={msg.content} />
            ) : (
              <AssistantBubble key={i} msg={msg} />
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div
        style={{
          borderTop: '1px solid #e5e7eb',
          padding: '12px 24px 20px',
          background: '#fff',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            border: '1.5px solid',
            borderColor: loading ? '#93c5fd' : '#d1d5db',
            borderRadius: 14,
            padding: '8px 8px 8px 14px',
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about FastAPI… (Enter to send)"
            rows={1}
            disabled={loading}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              resize: 'none',
              fontSize: 15,
              lineHeight: 1.55,
              fontFamily: 'inherit',
              color: '#111827',
              background: 'transparent',
              overflowY: 'hidden',
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            style={{
              background: loading || !input.trim() ? '#e5e7eb' : '#2563eb',
              color: loading || !input.trim() ? '#9ca3af' : '#fff',
              border: 'none',
              borderRadius: 10,
              width: 36,
              height: 36,
              cursor: loading || !input.trim() ? 'default' : 'pointer',
              fontSize: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {loading ? '…' : '↑'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '6px 4px 0', textAlign: 'center' }}>
          Shift+Enter for newline · answers cite source docs · may refuse if unsure
        </p>
      </div>
    </div>
  );
}
