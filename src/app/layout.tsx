import type { Metadata } from 'next';
import { Inspector } from 'react-dev-inspector';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: '\u4fc4\u7f57\u65af\u65b9\u5757 - \u5c0f\u79cd\u5b50\u53d1\u82bd\u4e2d',
    template: '%s',
  },
  description: '\u4fc4\u7f57\u65af\u65b9\u5757\u8054\u673a\u4e0e\u5355\u673a\u5bf9\u6218\u8bd5\u73a9\u7248\u3002',
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const isDev = process.env.NODE_ENV === 'development';

  return (
    <html lang="zh-CN">
      <body className="antialiased">
        {isDev && <Inspector />}
        {children}
      </body>
    </html>
  );
}
