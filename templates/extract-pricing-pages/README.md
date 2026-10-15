# extract-pricing-pages

Extract structured pricing fields from product pages with Zenrows Extract.

```bash
# Default: extract=auto on a prepared domain (site-tailored JSON).
# Not prepared yet (EXTRACT_DOMAIN_NOT_ENABLED)? zenrows extract prepare <domain> --url <product-url> --wait
zenrows extract https://www.owler.com/company/meltwater

# A precise CSS selector map, on any domain
zenrows extract <product-url> --css '{"title":"h1","price":".price"}' --validate
```

Requires `extract`. Start on one page, confirm the fields, then
fan out `zenrows extract` across the rest of your URLs.
