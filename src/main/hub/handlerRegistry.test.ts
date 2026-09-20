import { describe, expect, it } from 'vitest'
import { HandlerRegistry } from './handlerRegistry'

describe('transport-neutral handler registry', () => {
  it('retains context, activation gates, arguments and async results', async () => {
    const commands = new HandlerRegistry<{ active: boolean; userId: string }>()
    commands.register('task:get', async (context, id: string) => {
      if (!context.active) throw new Error('Session not activated')
      return { userId: context.userId, id }
    })
    expect(commands.channels()).toEqual(['task:get'])
    await expect(commands.invoke('task:get', { active: false, userId: 'a' }, 'task')).rejects.toThrow('Session not activated')
    await expect(commands.invoke('task:get', { active: true, userId: 'b' }, 'task')).resolves.toEqual({ userId: 'b', id: 'task' })
    expect(() => commands.register('task:get', () => null)).toThrow('already registered')
    expect(() => commands.invoke('missing', { active: true, userId: 'b' })).toThrow('No handler registered')
  })
})
