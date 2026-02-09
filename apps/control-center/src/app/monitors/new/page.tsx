import { createMonitor } from "@/actions/monitor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function NewMonitorPage() {
  return (
    <div className="max-w-2xl mx-auto mt-10">
      <Card>
        <CardHeader>
          <CardTitle>Neuen Monitor erstellen</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createMonitor} className="space-y-6">
            
            <div className="space-y-2">
              <Label htmlFor="query">Suchbegriff (Was suchst du?)</Label>
              <Input name="query" id="query" placeholder="z.B. Stussy Hoodie, Carhartt Detroit..." required />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="price_min">Min Preis (€)</Label>
                <Input type="number" name="price_min" id="price_min" placeholder="0" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="price_max">Max Preis (€)</Label>
                <Input type="number" name="price_max" id="price_max" placeholder="100" />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="size_id">Größen IDs (Kommagetrennt)</Label>
              <Input name="size_id" id="size_id" placeholder="208,209 (für M, L)" />
              <p className="text-xs text-muted-foreground">M=208, L=209, XL=210, XXL=211</p>
            </div>

            <div className="flex justify-end gap-2">
               <Button type="submit" className="w-full">Scraper Starten 🚀</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
