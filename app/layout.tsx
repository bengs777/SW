import type { Metadata } from 'next'
import { ClerkProvider } from '@clerk/nextjs'
import './globals.css'

export const metadata: Metadata = {
  title: 'Swift - Pembangun Web AI untuk Indonesia',
  description: 'Bangun aplikasi web dengan AI. Jelaskan apa yang Anda inginkan, saksikan menjadi kenyataan.',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <ClerkProvider>
      <html lang="id" suppressHydrationWarning className="bg-background">
        <head>
          <script
            dangerouslySetInnerHTML={{
              __html: `
                (function() {
                  try {
                    const clean = function(el) {
                      if (!el || !el.removeAttribute) return;
                      if (el.hasAttribute('bis_skin_checked')) el.removeAttribute('bis_skin_checked');
                      if (el.hasAttribute('bis_register')) el.removeAttribute('bis_register');
                      if (el.attributes) {
                        for (let i = el.attributes.length - 1; i >= 0; i--) {
                          const attr = el.attributes[i].name;
                          if (attr && attr.startsWith('__processed_')) {
                            el.removeAttribute(attr);
                          }
                        }
                      }
                    };
                    const observer = new MutationObserver(function(mutations) {
                      for (let i = 0; i < mutations.length; i++) {
                        const m = mutations[i];
                        if (m.type === 'attributes') {
                          clean(m.target);
                        } else if (m.type === 'childList') {
                          for (let j = 0; j < m.addedNodes.length; j++) {
                            const node = m.addedNodes[j];
                            if (node && node.nodeType === 1) {
                              clean(node);
                              if (node.querySelectorAll) {
                                const nested = node.querySelectorAll('[bis_skin_checked], [bis_register]');
                                for (let k = 0; k < nested.length; k++) clean(nested[k]);
                              }
                            }
                          }
                        }
                      }
                    });
                    observer.observe(document.documentElement, {
                      attributes: true,
                      subtree: true,
                      childList: true,
                      attributeFilter: ['bis_skin_checked', 'bis_register']
                    });
                    if (document.readyState === 'loading') {
                      window.addEventListener('DOMContentLoaded', function() {
                        const els = document.querySelectorAll('[bis_skin_checked], [bis_register]');
                        for (let i = 0; i < els.length; i++) clean(els[i]);
                        setTimeout(function() { observer.disconnect(); }, 3000);
                      });
                    } else {
                      const els = document.querySelectorAll('[bis_skin_checked], [bis_register]');
                      for (let i = 0; i < els.length; i++) clean(els[i]);
                      setTimeout(function() { observer.disconnect(); }, 3000);
                    }
                  } catch (e) {}
                })();
              `,
            }}
          />
        </head>
        <body className="antialiased" suppressHydrationWarning>
          {children}
        </body>
      </html>
    </ClerkProvider>
  )
}
