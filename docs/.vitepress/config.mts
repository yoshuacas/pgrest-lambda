import { defineConfig } from 'vitepress'
import llmstxt from 'vitepress-plugin-llms'

// TODO: confirm the final hostname before going live.
const HOSTNAME = 'https://pgrest-lambda.example.com' // <!-- TODO: confirm -->

export default defineConfig({
  title: 'pgrest-lambda',
  description:
    'A serverless REST API and auth layer for any PostgreSQL database — PostgREST-compatible, Supabase-client-compatible, Cedar-authorized.',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: HOSTNAME },
  ignoreDeadLinks: true,

  srcExclude: [
    'code-review/**',
    'design/**',
    'plans/**',
    'research/**',
    'security/**',
    'tasks/**',
    'authorization.md',
    'configuration.md',
    'rpc.md',
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
