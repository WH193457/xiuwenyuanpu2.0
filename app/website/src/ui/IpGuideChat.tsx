import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { brandAssets } from '../config'
import { askGuide, GUIDE_QUICK_PROMPTS, type GuideMessage } from '../guideChat'
import { Icon } from './Icon'

const WELCOME: GuideMessage = {
  id: 'welcome',
  role: 'assistant',
  text: '我是侗纹守护者。点下方快捷问题，或直接问纹样编号、创生与文创流程。',
  links: [
    { label: '纹样库', to: '/patterns' },
    { label: '创生工坊', to: '/create' },
  ],
}

export function IpGuideChat() {
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<GuideMessage[]>([WELCOME])
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
    window.setTimeout(() => inputRef.current?.focus(), 180)
  }, [open, messages, busy])

  const send = async (text: string) => {
    const question = text.trim()
    if (!question || busy) return
    setInput('')
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', text: question }])
    setBusy(true)
    try {
      const reply = await askGuide(question)
      setMessages((prev) => [...prev, reply])
    } catch {
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: '刚才没听清，请再试一次，或换个问法。',
      }])
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void send(input)
  }

  return <div className={`ip-guide ${open ? 'is-open' : ''}`}>
    <AnimatePresence>
      {open && (
        <motion.section
          className="ip-guide-panel"
          role="dialog"
          aria-label="侗纹守护者智能问答"
          initial={{ opacity: 0, y: reduce ? 0 : 16, scale: reduce ? 1 : 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: reduce ? 0 : 12, scale: reduce ? 1 : 0.96 }}
          transition={{ duration: reduce ? 0.1 : 0.28 }}
        >
          <header className="ip-guide-head">
            <img src={brandAssets.ip} alt="" />
            <div>
              <strong>侗纹守护者</strong>
              <span>智能问答 · 导览助手</span>
            </div>
            <button type="button" className="ip-guide-close" onClick={() => setOpen(false)} aria-label="关闭问答">
              <Icon name="close" size={16} />
            </button>
          </header>

          <div className="ip-guide-messages" ref={listRef}>
            {messages.map((message) => (
              <article key={message.id} className={`ip-bubble ${message.role}`}>
                <p>{message.text}</p>
                {message.links && message.links.length > 0 && (
                  <div className="ip-bubble-links">
                    {message.links.map((link) => (
                      <Link key={link.to + link.label} to={link.to} onClick={() => setOpen(false)}>{link.label}</Link>
                    ))}
                  </div>
                )}
              </article>
            ))}
            {busy && <article className="ip-bubble assistant is-typing"><i /><i /><i /></article>}
          </div>

          <div className="ip-guide-quick">
            {GUIDE_QUICK_PROMPTS.map((prompt) => (
              <button key={prompt} type="button" disabled={busy} onClick={() => void send(prompt)}>{prompt}</button>
            ))}
          </div>

          <form className="ip-guide-form" onSubmit={onSubmit}>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="问问纹样、流程或入口…"
              aria-label="输入问题"
              disabled={busy}
              maxLength={200}
            />
            <button type="submit" className="button primary" disabled={busy || !input.trim()} aria-label="发送">
              <Icon name="spark" size={16} />
            </button>
          </form>
        </motion.section>
      )}
    </AnimatePresence>

    <button
      type="button"
      className="ip-guide-fab"
      aria-expanded={open}
      aria-label={open ? '关闭侗纹守护者问答' : '打开侗纹守护者智能问答'}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="ip-guide-fab-ring" aria-hidden="true" />
      <img src={brandAssets.ip} alt="" />
      {!open && <span className="ip-guide-hint">问我</span>}
    </button>
  </div>
}
