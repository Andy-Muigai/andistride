# Andistride by Andifusion — website + checkout

Shop: `public/index.html` · Checkout: `public/checkout.html` · Server: `server.js`

## Change products, prices, stock, delivery fees
Everything lives in **`data/products.json`**:
- **Prices** → `priceBands` (25–30, 31–36, 37–42)
- **Delivery fees** → `delivery` (town → fee per option: `matatu`, `g4s`, `wells`), dispatched from Eldoret. Options and their descriptions → `deliveryMethods`.
- **Products** → `products`. Each has `code`, `name`, `category`, `image`,
  `minSize`, `maxSize`, `inStock` (false = shows "Sold out"), `limited`
  (true = "Limited stock" badge), `soldOutSizes` (e.g. `[25, 26]`).
- **New product photo** → add it to `public/images/` and point `image` at it.

Commit the change → Render redeploys automatically in a minute or two.

## Payments
- `PAYMENT_MODE=manual` (now): customer gets NCBA Paybill 880100 / Account 849292 and
  a WhatsApp button to send you the M-Pesa code.
- `PAYMENT_MODE=stk` (once you have your own Safaricom paybill and Daraja go-live):
  automatic M-Pesa prompt. Fill the `MPESA_*` variables.

## Order flow
1. Customer places an order → status **To confirm**; they see a private order page (`/order?no=…&k=…`) saying "we're checking stock, don't pay yet".
2. You check stock in **/admin** → **Confirm – in stock** (customer's page shows paybill details; WhatsApp opens with a message and their link) or **Not available** (add a note, e.g. another size).
3. Customer pays → **Mark paid** (M-Pesa code) → **Mark dispatched** (parcel details) → **Mark delivered**. Their page updates at each step.

## Orders and eTIMS
Open **/admin** on your site and log in with your `ADMIN_TOKEN`: see orders, mark them paid (with the M-Pesa code), dispatched or delivered, save the eTIMS invoice number, and WhatsApp or call the customer.

Raw data: `/api/admin/orders?token=YOUR_ADMIN_TOKEN` lists orders with the net / VAT / gross
lines to enter in the free KRA eTIMS app.
Mark a manual payment as paid:
`curl -X POST "https://YOUR-SITE/api/admin/orders/AND-12345/paid?token=TOKEN" -H "Content-Type: application/json" -d '{"mpesaCode":"SKX12ABC34"}'`

## Run locally
`npm install` → copy `.env.example` to `.env` → `npm start` → open http://localhost:3000

## Deploy on Render (free)
1. render.com → sign in with GitHub → **New → Blueprint** → pick this repository.
2. It reads `render.yaml`, installs and starts the site. Your link: `https://andistride.onrender.com`
   (or similar). Find `ADMIN_TOKEN` under Environment.
3. Custom domain (e.g. andistride.co.ke): Settings → Custom Domains, then add the DNS
   records Render shows at your domain registrar.

Notes: the free plan sleeps after inactivity (first visit takes ~30–60 s to wake) and
`orders.json` is wiped on restart/redeploy — move orders to a database (e.g. free Supabase)
before relying on it, or upgrade the plan.
