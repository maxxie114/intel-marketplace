import { ShoppingBag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { IntelSeller } from "@/api";

interface MarketplaceSidebarProps {
  sellers: IntelSeller[];
}

export default function MarketplaceSidebar({ sellers }: MarketplaceSidebarProps) {
  return (
    <div className="flex flex-col h-full bg-card border-r">
      <div className="flex items-center gap-2 px-4 py-3">
        <ShoppingBag className="h-4 w-4 text-primary" />
        <span className="font-semibold text-sm">Intel Sources</span>
        {sellers.length > 0 && (
          <Badge className="ml-auto h-5 text-[10px]">{sellers.length}</Badge>
        )}
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-3">
          {sellers.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-8 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
              <span className="text-sm">Discovering agents...</span>
            </div>
          )}
          {sellers.map((seller, i) => (
            <Card key={seller.endpointUrl || i} className="shadow-none">
              <CardHeader className="p-3 pb-1">
                <CardTitle className="text-sm">{seller.name}</CardTitle>
                {seller.teamName && (
                  <p className="text-xs text-muted-foreground">by {seller.teamName}</p>
                )}
                {seller.description && (
                  <p className="text-xs text-muted-foreground leading-snug line-clamp-2 mt-0.5">
                    {seller.description}
                  </p>
                )}
              </CardHeader>
              <CardContent className="p-3 pt-2 space-y-2">
                {seller.category && (
                  <Badge variant="outline" className="text-[10px]">
                    {seller.category}
                  </Badge>
                )}
                {seller.keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {seller.keywords.slice(0, 4).map((kw) => (
                      <Badge
                        key={kw}
                        variant="secondary"
                        className="text-[10px] bg-blue-50 text-blue-700 border-0"
                      >
                        {kw}
                      </Badge>
                    ))}
                  </div>
                )}
                {seller.pricing?.perRequest && (
                  <div className="text-xs text-muted-foreground">
                    {seller.pricing.perRequest} {seller.pricing.meteringUnit ?? "credits"} / request
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
