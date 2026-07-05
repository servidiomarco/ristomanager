import {
    Baby, Dog, Cat, Cake, Heart, VolumeX, Mountain, TreePine, Sun, Moon,
    Wine, Coffee, Gift, Sparkles, Star, Camera, Music, MapPin, Accessibility,
    Users, Flame, Snowflake, Umbrella, PartyPopper, Wheat, Fish, Beef,
    Utensils, GlassWater, IceCream, Armchair, LucideIcon,
} from 'lucide-react';

// Whitelist of lucide icons that can be attached to a reservation note preset.
// The key ("baby", "dog", ...) is what gets persisted; unknown keys render as
// no icon so removing/renaming an entry can't break existing rows.
export const RESERVATION_NOTE_ICONS: Record<string, LucideIcon> = {
    baby: Baby,
    dog: Dog,
    cat: Cat,
    cake: Cake,
    heart: Heart,
    'volume-x': VolumeX,
    mountain: Mountain,
    tree: TreePine,
    sun: Sun,
    moon: Moon,
    wine: Wine,
    coffee: Coffee,
    gift: Gift,
    sparkles: Sparkles,
    star: Star,
    camera: Camera,
    music: Music,
    'map-pin': MapPin,
    accessibility: Accessibility,
    users: Users,
    flame: Flame,
    snowflake: Snowflake,
    umbrella: Umbrella,
    party: PartyPopper,
    wheat: Wheat,
    fish: Fish,
    beef: Beef,
    utensils: Utensils,
    'glass-water': GlassWater,
    'ice-cream': IceCream,
    armchair: Armchair,
};

export const RESERVATION_NOTE_ICON_KEYS = Object.keys(RESERVATION_NOTE_ICONS);

// Short human label per icon so the picker can list them meaningfully. Falls
// back to the key when a label is missing.
export const RESERVATION_NOTE_ICON_LABELS: Record<string, string> = {
    baby: 'Bambino / Seggiolone',
    dog: 'Cane',
    cat: 'Gatto',
    cake: 'Compleanno',
    heart: 'Anniversario / Romantico',
    'volume-x': 'Silenzioso',
    mountain: 'Vista',
    tree: 'Esterno / Giardino',
    sun: 'Pranzo / Sole',
    moon: 'Cena / Sera',
    wine: 'Vino',
    coffee: 'Caffè',
    gift: 'Regalo',
    sparkles: 'Speciale',
    star: 'VIP',
    camera: 'Foto',
    music: 'Musica',
    'map-pin': 'Posizione',
    accessibility: 'Accessibilità',
    users: 'Gruppo',
    flame: 'Fumatore',
    snowflake: 'Aria condizionata',
    umbrella: 'Coperto',
    party: 'Festa',
    wheat: 'Senza glutine',
    fish: 'Pesce',
    beef: 'Carne',
    utensils: 'Menu speciale',
    'glass-water': 'Acqua',
    'ice-cream': 'Dessert',
    armchair: 'Comodo',
};

export const getReservationNoteIcon = (key?: string | null): LucideIcon | null => {
    if (!key) return null;
    return RESERVATION_NOTE_ICONS[key] || null;
};
