import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Skincare Shop Manager',
    template: '%s · Skincare Shop Manager',
  },
  description:
    'Inventory, point of sale and financial ledger for a skincare retail shop.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}