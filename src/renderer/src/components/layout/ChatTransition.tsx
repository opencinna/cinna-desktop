import { Component, createRef, type ReactNode } from 'react'

interface Props {
  chatId: string | null
  enabled: boolean
  children: ReactNode
}

interface Snapshot {
  element: HTMLDivElement
  scroll: { element: Element; top: number; left: number }[]
}

/** Capture the outgoing DOM before React updates it, without mounting a second
 * chat (and its subscriptions, composer and effects) or delaying navigation. */
export class ChatTransition extends Component<Props> {
  private host = createRef<HTMLDivElement>()
  private content = createRef<HTMLDivElement>()
  private outgoing: HTMLDivElement | null = null
  private animations: Animation[] = []
  private reducedMotion: MediaQueryList | null = null

  componentDidMount(): void {
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
    this.reducedMotion?.addEventListener('change', this.stop)
    document.addEventListener('visibilitychange', this.stop)
  }

  componentWillUnmount(): void {
    this.stop()
    this.reducedMotion?.removeEventListener('change', this.stop)
    document.removeEventListener('visibilitychange', this.stop)
  }

  private stop = (): void => {
    this.animations.forEach((animation) => animation.cancel())
    this.animations = []
    this.outgoing?.remove()
    this.outgoing = null
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    if (previous.chatId === this.props.chatId) return null
    this.stop()
    const content = this.content.current
    if (!this.props.enabled || this.reducedMotion?.matches || document.hidden || !content?.animate) {
      return null
    }

    const element = content.cloneNode(true) as HTMLDivElement
    element.className = 'chat-transition-snapshot'
    element.setAttribute('aria-hidden', 'true')
    element.inert = true
    const sources = content.querySelectorAll('*')
    const copies = element.querySelectorAll('*')
    const scroll: Snapshot['scroll'] = []
    sources.forEach((source, index) => {
      const copy = copies[index]
      copy.removeAttribute('id')
      copy.removeAttribute('autofocus')
      if (source.scrollTop || source.scrollLeft) {
        scroll.push({ element: copy, top: source.scrollTop, left: source.scrollLeft })
      }
    })
    return { element, scroll }
  }

  componentDidUpdate(_previous: Props, _state: unknown, snapshot: Snapshot | null): void {
    if (!this.props.enabled) {
      this.stop()
      return
    }
    if (!snapshot || !this.host.current || !this.content.current) return
    this.outgoing = snapshot.element
    this.host.current.append(snapshot.element)
    // Scroll offsets only stick once the clone participates in layout.
    snapshot.scroll.forEach(({ element, top, left }) => {
      element.scrollTop = top
      element.scrollLeft = left
    })
    // Oversized gradient masks create a soft curtain edge sweeping from the
    // upper left to the lower right. Reveal starts only after the old chat exits.
    const exitMask = {
      maskImage: 'linear-gradient(135deg, transparent 46%, black 54%)',
      maskSize: '240% 240%',
      maskRepeat: 'no-repeat'
    }
    const enterMask = {
      ...exitMask,
      maskImage: 'linear-gradient(135deg, black 46%, transparent 54%)'
    }
    const outgoing = snapshot.element.animate([
      { ...exitMask, maskPosition: '100% 100%', opacity: 1 },
      { ...exitMask, maskPosition: '0% 0%', opacity: 0 }
    ], { duration: 110, easing: 'ease-in', fill: 'forwards' })
    const incoming = this.content.current.animate([
      { ...enterMask, maskPosition: '100% 100%', opacity: 0 },
      { ...enterMask, maskPosition: '0% 0%', opacity: 1 }
    ], { delay: 110, duration: 150, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' })
    this.animations = [outgoing, incoming]
    void Promise.all([outgoing.finished, incoming.finished]).then(() => {
      // A rapid switch may already own a different outgoing snapshot.
      if (this.outgoing === snapshot.element) this.stop()
    }).catch(() => { /* Cancellation on another switch or unmount is expected. */ })
  }

  render(): ReactNode {
    return (
      <div ref={this.host} className="chat-transition">
        <div ref={this.content} className="chat-transition-content">{this.props.children}</div>
      </div>
    )
  }
}
