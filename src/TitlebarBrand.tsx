import { useEffect, useState } from "react";
import { BrandIcon } from "./BrandIcon";

const titles = [
  "Rote Coding Fraktion",
  "Rote Magick Fraktion!",
  "God Left a Long Time Ago",
  "Karg Nacht",
  "Karg",
  "Assassination",
  "Firtan",
  "TRNA",
  "Harakiri for the Sky",
  "Ellende",
  "Lifelover",
  "Hypothermia",
  "Ghost Bath — The Sleeping Fields",
];

const rotationInterval = 21_000;

export function TitlebarBrand() {
  const [step, setStep] = useState(0);
  const index = step % titles.length;

  useEffect(() => {
    const timer = window.setInterval(
      () => setStep((current) => current + 1),
      rotationInterval,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="title-center" aria-hidden="true">
      <BrandIcon className="brand-glyph" />
      <div className="title-phrases" key={step}>
        {step > 0 && (
          <span className="title-phrase-out">
            {titles[(step - 1) % titles.length]}
          </span>
        )}
        <span className={step === 0 ? undefined : "title-phrase-in"}>
          {titles[index]}
        </span>
      </div>
    </div>
  );
}
