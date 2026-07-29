# extract-pricing-pages

Extract structured pricing fields from product pages with Zenrows Extract.

```bash
# Autoparse (automatic structured JSON)
zenrows extract https://www.scrapingcourse.com/ecommerce/ --autoparse

# Or a precise CSS selector map
zenrows extract <product-url> --css '{"title":"h1","price":".price"}' --validate
```

Requires `extract` (available). Start on one page, confirm the fields, then
fan out `zenrows extract` across the rest of your URLs.
