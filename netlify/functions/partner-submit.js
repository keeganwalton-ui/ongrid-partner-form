// netlify/functions/partner-submit.js
// On partner form submission:
//   1. Creates an entry in Notion Partner Applications database
//   2. Creates (or updates) a Shopify customer with partner tags
//      so they appear in Shopify customer segments and abandoned
//      checkout / email automation flows
//
// Required env vars (Netlify dashboard -> Site settings -> Environment variables):
//   NOTION_TOKEN          -- Notion internal integration secret (secret_xxx...)
//   SHOPIFY_STORE         -- store handle only, e.g. ongridsmart (no .myshopify.com)
//   SHOPIFY_ADMIN_TOKEN   -- Shopify Admin API access token (shpat_xxx...)

exports.handler = async function(event) {
  const ALLOWED_ORIGIN = 'https://ongridsmart.com';

  const corsHeaders = {
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { partnerName, businessName, email, phone, city, website, partnerType, why, dateApplied } = body;

  if (!partnerName || !email || !partnerType) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing required fields: partnerName, email, partnerType' })
    };
  }

  const nameParts = partnerName.trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || '';
  const today     = dateApplied || new Date().toISOString().split('T')[0];

  const NOTION_TOKEN        = process.env.NOTION_TOKEN;
  const SHOPIFY_STORE       = process.env.SHOPIFY_STORE;
  const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
  const NOTION_DB_ID        = 'c3741786ad564070aa0e7d394eca3c40';

  // Tags drive Shopify customer segments -> abandoned checkout + email automations
  const trackTagMap = {
    'Realtor / Agent':        'partner,partner-realtor',
    'Furniture / Home Store': 'partner,partner-store',
    'Airbnb / STR Host':      'partner,partner-str',
    'Other':                  'partner,partner-other'
  };
  const shopifyTags = trackTagMap[partnerType] || 'partner';

  // Run Notion write + Shopify customer upsert in parallel
  const [notionResult, shopifyResult] = await Promise.allSettled([

    // 1. Write to Notion Partner Applications database
    fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization':  'Bearer ' + NOTION_TOKEN,
        'Content-Type':   'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DB_ID },
        properties: {
          'Partner Name':             { title:        [{ text: { content: partnerName } }] },
          'Business Name':            { rich_text:    [{ text: { content: businessName || '' } }] },
          'Email':                    { email:        email },
          'Phone':                    { phone_number: phone || null },
          'City':                     { rich_text:    [{ text: { content: city || '' } }] },
          'Website or Social':        { url: (website && website.startsWith('http')) ? website : null },
          'Partner Type':             { select:       { name: partnerType } },
          'Why They Want to Partner': { rich_text:    [{ text: { content: why || '' } }] },
          'Status':                   { select:       { name: 'New' } },
          'Date Applied':             { date:         { start: today } },
          'Approved?':                { checkbox:     false }
        }
      })
    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); }),

    // 2. Shopify customer upsert
    // Search first to avoid duplicates
    fetch(
      'https://' + SHOPIFY_STORE + '.myshopify.com/admin/api/2024-04/customers/search.json?query=email:' + encodeURIComponent(email) + '&fields=id,email,tags',
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    )
    .then(function(r) { return r.json(); })
    .then(async function(searchData) {
      const existing = searchData.customers && searchData.customers[0];

      if (existing) {
        // Merge tags onto existing customer
        const existingTags = existing.tags ? existing.tags.split(', ').map(function(t) { return t.trim(); }) : [];
        const newTagList   = shopifyTags.split(',').map(function(t) { return t.trim(); });
        const mergedTags   = Array.from(new Set(existingTags.concat(newTagList))).join(', ');

        const res = await fetch(
          'https://' + SHOPIFY_STORE + '.myshopify.com/admin/api/2024-04/customers/' + existing.id + '.json',
          {
            method: 'PUT',
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              customer: {
                id:   existing.id,
                tags: mergedTags,
                note: 'Partner application submitted ' + today + '. Track: ' + partnerType + '. Business: ' + (businessName || 'N/A') + '.'
              }
            })
          }
        );
        const data = await res.json();
        return { ok: res.ok, action: 'updated', data: data };

      } else {
        // Create new Shopify customer
        const res = await fetch(
          'https://' + SHOPIFY_STORE + '.myshopify.com/admin/api/2024-04/customers.json',
          {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              customer: {
                first_name:       firstName,
                last_name:        lastName,
                email:            email,
                phone:            phone || null,
                tags:             shopifyTags,
                note:             'Partner application submitted ' + today + '. Track: ' + partnerType + '. Business: ' + (businessName || 'N/A') + '.',
                accepts_marketing: true,
                email_marketing_consent: {
                  state:              'subscribed',
                  opt_in_level:       'single_opt_in',
                  consent_updated_at: new Date().toISOString()
                },
                metafields: [
                  { namespace: 'partner', key: 'track',         value: partnerType,      type: 'single_line_text_field' },
                  { namespace: 'partner', key: 'business_name', value: businessName || '', type: 'single_line_text_field' },
                  { namespace: 'partner', key: 'applied_date',  value: today,             type: 'date' }
                ]
              }
            })
          }
        );
        const data = await res.json();
        return { ok: res.ok, action: 'created', data: data };
      }
    })

  ]);

  // Log errors server-side
  const notionOk  = notionResult.status === 'fulfilled' && notionResult.value.ok;
  const shopifyOk = shopifyResult.status === 'fulfilled' && shopifyResult.value.ok;

  if (!notionOk)  console.error('Notion error:',  JSON.stringify(notionResult.status  === 'fulfilled' ? notionResult.value  : notionResult.reason));
  if (!shopifyOk) console.error('Shopify error:', JSON.stringify(shopifyResult.status === 'fulfilled' ? shopifyResult.value : shopifyResult.reason));

  // Notion is the critical path -- form fails if it didn't write
  if (!notionOk) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({
        success: false,
        error:   'Could not save your application. Please email hello@ongridsmart.com.',
        notion:  false,
        shopify: shopifyOk
      })
    };
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({
      success:       true,
      notion:        true,
      shopify:       shopifyOk,
      shopifyAction: shopifyOk ? shopifyResult.value.action : 'failed'
    })
  };
};
