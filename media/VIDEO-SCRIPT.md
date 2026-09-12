# SARA showcase video — voiceover script

Video: `media/sara-showcase.webm` (1:50, live run on the NextCart storefront, fallback decider, no LLM key). Toasts at 0:18, 0:34, 0:48, 1:08.

**0:00–0:15 · home + category**
Every store has a chatbot in the corner. Nobody opens it. SARA doesn't wait to be asked. It lives in the page, watches how you shop, and decides on its own whether to help or stay quiet.

**0:15–0:30 · product page, first toast at 0:18**
I land on a product. SARA reads the page: price, sizes, stock, this store's own policies. Within seconds, one short note, top right. A real fact, from the merchant, never invented. It gets out of your way in six seconds.

**0:30–0:50 · size switching, toast at 0:34**
I'm switching sizes, hovering add-to-cart, not committing. Those are behavioral signals: variant churn, hesitation. Cheap deterministic gates score them first. The model is only asked when something looks like real friction.

**0:50–1:05 · second product and back, toast at 0:48**
I check another product, come back. SARA remembers what I compared and what differs. Nothing is lost between pages. The launcher badge is counting.

**1:05–1:25 · cart, toast at 1:08**
On the cart it switches to cart economics: shipping, the promo that applies to my basket, in the store's currency. Every card is a merchant-owned template. The model fills slots that are grounded in store data. It cannot make up a discount.

**1:25–1:40 · launcher open**
Everything it noticed this session, with a reason. Every decision has a trace: signals, hypothesis, decision, why. Including the decision to stay silent. Cooldowns, per-page caps and dismiss memory keep it from becoming another popup you learn to close.

**1:40–1:50 · search / close**
One script tag on any storefront. Deterministic fallback when the model is slow. A persistent decision log. SARA: an agent in the page, not in a chat box.
