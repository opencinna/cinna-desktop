/** An in-process command table. No network exposure or authorization bypass:
 * handlers retain their own activation checks and transport-specific context.
 * Each transport owns a registry with its own context type.
 */
export class HandlerRegistry<Context> {
  private readonly handlers = new Map<string, (context: Context, ...args: any[]) => unknown>()

  register<T>(channel: string, handler: (context: Context, ...args: any[]) => T): void {
    if (this.handlers.has(channel)) throw new Error(`Handler already registered: ${channel}`)
    this.handlers.set(channel, handler)
  }

  invoke(channel: string, context: Context, ...args: any[]): unknown {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered: ${channel}`)
    return handler(context, ...args)
  }

  channels(): string[] { return [...this.handlers.keys()] }
}
