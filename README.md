# Finn Hertsch

Minimalist, Zero-JS static portfolio and essay collection. 
Built with [Astro](https://astro.build) following principles of radical typography and mechanical sympathy.

## Architecture & Performance
- **Framework:** Astro (Static Site Generation)
- **Styling:** Pure CSS (System Fonts: Charter, JetBrains Mono)
- **Performance:** Asynchronous KaTeX injection, zero render-blocking resources, Astro hover-prefetching.
- **Deployment:** Vercel (Edge ready)

## Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

## Structure
- `src/content/essays/`: Markdown-based essays with KaTeX support.
- `src/components/`: Reusable Astro components (e.g., `<Publication />`).
- `src/layouts/`: Core HTML skeleton & SEO metadata.
