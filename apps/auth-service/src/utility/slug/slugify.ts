export function slugify(text: string, p0: { lower: boolean; strict: boolean; }): string {
    return text
        .toString()
        .normalize('NFD') // remove accents
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
