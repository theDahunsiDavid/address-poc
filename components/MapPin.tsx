import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { CanonicalAddress } from '@/lib/schema';

// Div icon instead of Leaflet's default image markers, so the bundler never
// has to resolve the marker-icon assets that break under module bundlers.

const pinIcon = L.divIcon({
  className: 'map-pin',
  html: '<div class="pin-dot"></div>',
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

export default function MapPin({ address }: { address: CanonicalAddress | null }) {
  const lat = address?.lat;
  const lng = address?.lng;
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return (
    <div className="map-wrap">
      <MapContainer center={[lat, lng]} zoom={15} style={{ height: 220, width: '100%', borderRadius: 6 }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Marker position={[lat, lng]} icon={pinIcon}>
          <Popup>{`${lat.toFixed(5)}, ${lng.toFixed(5)}`}</Popup>
        </Marker>
      </MapContainer>
    </div>
  );
}