import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'ReliaDesk',
  description: 'Agentic reliability desk: turns noisy factory alerts into approved maintenance actions.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
