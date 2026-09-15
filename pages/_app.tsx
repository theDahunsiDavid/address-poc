import type { AppProps } from 'next/app';
import '@/styles/globals.css';
import { Schibsted_Grotesk } from 'next/font/google';

// Self-hosted at build time. Closest freely-licensed match to Displaay's
// commercial Season Sans; swap the import here to change the typeface.
const sans = Schibsted_Grotesk({
  subsets: ['latin'],
  display: 'swap',
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className={sans.className}>
      <Component {...pageProps} />
    </div>
  );
}