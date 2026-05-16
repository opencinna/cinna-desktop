import type { Components } from 'react-markdown'

// target="_blank" routes through setWindowOpenHandler in src/main/index.ts,
// which calls shell.openExternal and denies the in-app window open.
export const markdownComponents: Components = {
  a: ({ children, href, ...props }) => (
    <a {...props} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}
