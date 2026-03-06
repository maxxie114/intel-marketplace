import { X, ExternalLink } from "lucide-react";
import type { ZeroClickOffer } from "@/api";

interface OffersBarProps {
  offers: ZeroClickOffer[];
  onDismiss: () => void;
}

export default function OffersBar({ offers, onDismiss }: OffersBarProps) {
  if (offers.length === 0) return null;

  return (
    <div className="border-t bg-gradient-to-r from-slate-50 to-blue-50 px-4 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
          Sponsored
        </span>
        <button
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {offers.map((offer) => (
          <a
            key={offer.id}
            href={(offer.url as string) ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 flex items-start gap-2 bg-white rounded-lg border p-2.5 hover:shadow-sm transition-shadow max-w-[260px] group"
          >
            {offer.image_url && (
              <img
                src={offer.image_url as string}
                alt=""
                className="h-8 w-8 rounded object-cover flex-shrink-0"
              />
            )}
            <div className="min-w-0">
              {offer.title && (
                <p className="text-xs font-medium text-foreground line-clamp-1 group-hover:text-blue-600">
                  {offer.title as string}
                </p>
              )}
              {offer.description && (
                <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">
                  {offer.description as string}
                </p>
              )}
              {offer.cta && (
                <div className="flex items-center gap-1 mt-1 text-[10px] text-blue-600">
                  <span>{offer.cta as string}</span>
                  <ExternalLink className="h-2.5 w-2.5" />
                </div>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
