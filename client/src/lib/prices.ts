export type PriceBlock = { heading: string; details: string };

export function buildPricesDescription(blocks: PriceBlock[]) {
  return blocks
    .map((block) => {
      const heading = block.heading.trim();
      const details = block.details.trim();
      if (!heading && !details) return "";
      return [heading ? `**${heading}**` : "", details].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

export function hasPriceContent(blocks: PriceBlock[]) {
  return buildPricesDescription(blocks).length > 0;
}

export function submitPricesForm(title: string, blocks: PriceBlock[], mutate: (payload: { title: string; description: string }) => void) {
  const normalizedTitle = title.trim();
  const description = buildPricesDescription(blocks);
  if (!normalizedTitle || !description) return false;
  mutate({ title: normalizedTitle, description });
  return true;
}
