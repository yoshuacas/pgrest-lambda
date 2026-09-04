import { defineConfig } from 'vitepress'
import llmstxt from 'vitepress-plugin-llms'

// Where the site actually publishes, from .github/workflows/deploy-docs.yml
// (GitHub Pages) and the `base` below. The sitemap and llms.txt embed this, so a
// placeholder here ships absolute URLs that resolve nowhere.
const HOSTNAME = 'https://yoshuacas.github.io/pgrest-lambda/'

export default defineConfig({
  title: 'pgrest-lambda',
  description:
    'A serverless REST API and auth layer for any PostgreSQL database — PostgREST-compatible, Supabase-client-compatible, Cedar-authorized.',
  base: '/pgrest-lambda/',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: HOSTNAME },
  ignoreDeadLinks: false,

  // The repo-rooted guides (authorization.md, configuration.md, rpc.md) are
  // built. They used to be excluded, which left 31 links across the site
  // pointing at 404s — every `../rpc.md` and `../authorization.md` reference in
  // reference/, guide/ and explanation/. `ignoreDeadLinks` hid that.
  srcExclude: [
    'code-review/**',
    'design/**',
    'plans/**',
    'research/**',
    'security/**',
    'tasks/**',
  ],

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { property: 'og:title', content: 'pgrest-lambda' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'A serverless REST API and auth layer for any PostgreSQL database.',
      },
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: HOSTNAME }],
  ],

  markdown: {
    lineNumbers: true,
  },

  vite: {
    plugins: [
      llmstxt({
        generateLLMsTxt: true,
        generateLLMsFullTxt: true,
        injectLLMHint: true,
        domain: HOSTNAME,
        title: 'pgrest-lambda Documentation',
        description:
          'Reference, guides, and tutorials for pgrest-lambda — a serverless REST API and auth layer for any PostgreSQL database.',
      }),
    ],
  },

  themeConfig: {
    nav: [
      { text: 'Tutorials', link: '/tutorials/getting-started' },
      { text: 'Guides', link: '/guide/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Explain', link: '/explanation/' },
    ],

    sidebar: {
      '/tutorials/': [
        {
          text: 'Tutorials',
          collapsed: false,
          items: [
            {
              text: 'Run your first pgrest-lambda query',
              link: '/tutorials/getting-started',
            },
          ],
        },
      ],

      '/guide/': [
        {
          text: 'How-to guides',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/guide/' },
            {
              text: 'How to use pgrest-lambda as a library',
              link: '/guide/use-as-a-library',
            },
            {
              text: 'How to deploy to AWS Lambda with SAM',
              link: '/guide/deploy-aws-sam',
            },
            {
              text: 'How to write Cedar row-level policies',
              link: '/guide/write-cedar-policies',
            },
            {
              text: 'How to lint Cedar policies',
              link: '/guide/lint-cedar-policies',
            },
          ],
        },
      ],

      '/reference/': [
        {
          text: 'Reference',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'CLI', link: '/reference/cli' },
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'HTTP API', link: '/reference/http-api' },
            { text: 'Resource embedding', link: '/reference/embedding' },
            { text: 'Authorization', link: '/reference/authorization' },
            { text: 'Error codes', link: '/reference/errors' },
            { text: 'Lint rules', link: '/reference/lint-rules' },
            {
              text: 'PostgREST compatibility',
              link: '/reference/postgrest-compatibility',
            },
            {
              text: 'Cedar equivalence',
              link: '/reference/cedar-equivalence',
            },
          ],
        },
        {
          text: 'In-depth guides',
          collapsed: false,
          items: [
            { text: 'RPC', link: '/rpc' },
            { text: 'Authorization (Cedar)', link: '/authorization' },
            { text: 'Configuration', link: '/configuration' },
          ],
        },
      ],

      '/explanation/': [
        {
          text: 'Explanation',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/explanation/' },
            {
              text: 'Why pgrest-lambda?',
              link: '/explanation/why-pgrest-lambda',
            },
            {
              text: 'How authorization works',
              link: '/explanation/how-authorization-works',
            },
          ],
        },
      ],
    },

    outline: [2, 3],

    search: { provider: 'local' },
    // When ready to move to Algolia:
    // search: {
    //   provider: 'algolia',
    //   options: { appId: '...', apiKey: '...', indexName: 'pgrest-lambda' },
    // },

    editLink: {
      pattern:
        'https://github.com/yoshuacas/pgrest-lambda/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/yoshuacas/pgrest-lambda' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 pgrest-lambda contributors',
    },
  },
})
