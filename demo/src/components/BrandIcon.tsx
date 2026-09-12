// A static version of production's BrandLogo.tsx — same watermelon
// artwork (favicon.png, already copied into demo/public/ for the tab
// icon), without the 6-frame hover "being eaten" animation. Porting the
// animation would mean copying its 7-frame PNG sequence from
// app/public/logo-anim/ purely for a cosmetic flourish; skipped as a
// deliberate, low-value scope cut rather than an oversight.
export function BrandIcon() {
  return <img src={`${import.meta.env.BASE_URL}favicon.png`} alt="" className="brand-logo" />;
}
