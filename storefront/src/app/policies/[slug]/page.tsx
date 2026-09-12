import { notFound } from "next/navigation";
import type { Metadata } from "next";

interface PolicyContent {
  title: string;
  intro: string;
  sections: { heading: string; body: string[] }[];
}

const POLICIES: Record<string, PolicyContent> = {
  shipping: {
    title: "Shipping Policy",
    intro:
      "We ship to addresses across the country and aim to get every order to you quickly and reliably.",
    sections: [
      {
        heading: "Processing time",
        body: [
          "Orders are processed within 1 business day of being placed. You'll receive a confirmation as soon as your order is placed, and orders are packed and handed to the carrier the next business day, Monday through Friday, excluding public holidays.",
        ],
      },
      {
        heading: "Delivery options",
        body: [
          "Standard delivery typically arrives within 3-5 business days of dispatch and is included on eligible orders.",
          "Express delivery typically arrives within 1-2 business days of dispatch, for an additional fee shown at checkout.",
          "Delivery estimates are business days and start once an order has shipped, not once it is placed. Remote areas may take slightly longer.",
        ],
      },
      {
        heading: "Order tracking",
        body: [
          "Once your order ships, you can track its progress from your order history. If a package appears delayed or lost in transit, contact customer support and we'll investigate with the carrier.",
        ],
      },
      {
        heading: "Shipping restrictions",
        body: [
          "We currently ship only within the country the order is placed from. Some oversized or hazardous items may have additional shipping restrictions noted on the product page.",
        ],
      },
    ],
  },
  returns: {
    title: "Returns Policy",
    intro:
      "If something isn't right, most items can be returned within 30 days of delivery for a refund or exchange.",
    sections: [
      {
        heading: "Return window",
        body: [
          "You have 30 days from the date of delivery to start a return. Items must be unused, in their original packaging, and in the same condition you received them.",
        ],
      },
      {
        heading: "How to start a return",
        body: [
          "Start a return from your order history, or contact customer support with your order number. We'll provide instructions and, where applicable, a prepaid return label.",
        ],
      },
      {
        heading: "Refunds",
        body: [
          "Once your return is received and inspected, we'll notify you of the approval status. Approved refunds are issued to your original payment method within 5-7 business days. Orders paid by cash on delivery are refunded to the account on file.",
        ],
      },
      {
        heading: "Exclusions",
        body: [
          "Perishable goods, personal care items that have been opened, and gift cards are not eligible for return. Items marked \"final sale\" on the product page cannot be returned or exchanged.",
        ],
      },
      {
        heading: "Damaged or incorrect items",
        body: [
          "If an item arrives damaged or isn't what you ordered, contact customer support within 7 days of delivery for a free replacement or full refund — no return shipping required.",
        ],
      },
    ],
  },
};

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const policy = POLICIES[slug];
  return { title: policy ? `${policy.title} — NextCart` : "NextCart" };
}

export default async function PolicyPage({ params }: PageProps) {
  const { slug } = await params;
  const policy = POLICIES[slug];
  if (!policy) notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">{policy.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{policy.intro}</p>
      </header>

      <div className="flex flex-col gap-6">
        {policy.sections.map((section) => (
          <section key={section.heading}>
            <h2 className="text-lg font-semibold text-slate-800">{section.heading}</h2>
            <div className="mt-2 flex flex-col gap-2">
              {section.body.map((paragraph, index) => (
                <p key={index} className="text-sm leading-relaxed text-slate-600">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function generateStaticParams() {
  return Object.keys(POLICIES).map((slug) => ({ slug }));
}
