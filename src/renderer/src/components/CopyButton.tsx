import { useState } from 'react'
import { Icon } from './Icon'

export function CopyButton({ text, label = 'Copy', small = true }: { text: string | (() => string); label?: string; small?: boolean }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={`btn ${small ? 'small' : ''}`}
      onClick={async () => {
        await window.tfdesk.copyText(typeof text === 'function' ? text() : text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      }}
    >
      <Icon name="copy" size={13} />
      {copied ? 'Copied' : label}
    </button>
  )
}
