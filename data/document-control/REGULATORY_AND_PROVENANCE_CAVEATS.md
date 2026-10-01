# Regulatory and Provenance Caveats from the Supplied Template Packs

These caveats are preserved from the uploaded template packages and must survive implementation.

1. The compliance and permits templates are **internal LeaseOS records**, not official government forms.
2. The DOT/FMCSA template must not be represented as an official FMCSA filing or form.
3. The oilfield Waste Manifest / Hazardous Waste Manifest PDF is an **internal companion record**, not the official EPA Uniform Hazardous Waste Manifest. When an official manifest/e-Manifest process applies, Document Control must attach/link the official record rather than replace it with the LeaseOS internal form.
4. NORM requirements are jurisdiction-specific; the template pack does not establish universal regulatory rules.
5. State, tribal, provincial, territorial, local, and other jurisdiction requirements may add or alter requirements.
6. The structured compliance pack intentionally defaults regulator-derived facts to an unverified state and marks precision-sensitive facts such as quantities, dates, times, readings, weights, and identifiers for careful confirmation.
7. Document Control must distinguish `issuer`, `origin`, `template source`, `verification state`, and `official/external reference` so an internal record is never misrepresented as a regulator-issued document.

Implementation must preserve these statements as product behavior, not merely README prose.
