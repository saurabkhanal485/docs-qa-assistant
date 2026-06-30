import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Docs Q&A Assistant',
  description: 'Ask questions about the FastAPI docs and get grounded, cited answers.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
