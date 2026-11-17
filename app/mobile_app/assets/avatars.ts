// Bundled avatar images. React Native's Metro bundler needs static require() calls,
// so we list every avatar explicitly here. Add new entries when you add new PNGs.

export interface Avatar {
    id: string;          // stable key stored in DB / Supabase
    name: string;        // shown in the picker
    source: any;         // require()'d image
}

export const AVATARS: Avatar[] = [
    { id: 'artist_girl',           name: 'Artist Girl',           source: require('./profile/Artist Girl.png') },
    { id: 'cat_ear_hoodie',        name: 'Cat-Ear Hoodie',        source: require('./profile/Cat-Ear Hoodie Character.png') },
    { id: 'cheerful_manga_boy',    name: 'Cheerful Manga Boy',    source: require('./profile/Cheerful Manga Boy.png') },
    { id: 'cozy_office_worker',    name: 'Cozy Office Worker',    source: require('./profile/Cozy Office Worker.png') },
    { id: 'cozy_reader_girl',      name: 'Cozy Reader Girl',      source: require('./profile/Cozy Reader Girl.png') },
    { id: 'gamer_reader',          name: 'Gamer Reader',          source: require('./profile/Gamer Reader.png') },
    { id: 'quiet_glasses_boy',     name: 'Quiet Glasses Boy',     source: require('./profile/Quiet Glasses Boy.png') },
    { id: 'sleepy_hoodie_girl',    name: 'Sleepy Hoodie Girl',    source: require('./profile/Sleepy Hoodie Girl.png') },
    { id: 'sleepy_student',        name: 'Sleepy Student',        source: require('./profile/Sleepy Student.png') },
    { id: 'soft_goth_reader',      name: 'Soft Goth Reader',      source: require('./profile/Soft Goth Reader.png') },
    { id: 'sporty_reader_girl',    name: 'Sporty Reader Girl',    source: require('./profile/Sporty Reader Girl.png') },
    { id: 'tiny_chibi_mascot',     name: 'Tiny Chibi Mascot',     source: require('./profile/Tiny Chibi Mascot.png') },
];

export function getAvatarById(id: string | null | undefined): Avatar | null {
    if (!id) return null;
    return AVATARS.find(a => a.id === id) || null;
}
