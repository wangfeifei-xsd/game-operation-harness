---
kind: upgrade-guide
description: "The embedded business assistant requires a Harness account created and linked by a club administrator."
---
# Business assistant requires club authorization

English | [中文](guide.zh.md)

## Change

Earlier embedded clients could create or link an account during pairing and use a login code to authorize Harness. The embedded assistant now opens with the Harness account selected by the club administrator. Protocol 2 pairs the device and workspace after the business page starts the authorized session. Earlier login codes, self-service links, and pairing records expire at the upgrade.

## Migration

1. Deploy Creativity migration `0064_harness_authorization`, the updated Core backend, and matching versions of the `/embed` page and local Harness client.
2. In Core, use **Club settings → Agent assistant authorization** to search for each intended user. Create and link a Harness account through the registration form.
3. Sign in to Core or the PC app and open Agent Assistant. Confirm that the assistant opens using the linked account. In local Harness, select **Connect Business Assistant**, enter the new pairing code, and confirm the intended device and workspace from the business page.
