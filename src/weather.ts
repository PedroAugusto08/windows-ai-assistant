import { invoke, isTauri } from '@tauri-apps/api/core';

export interface WeatherPlace { id: number; name: string; admin1: string; country: string; latitude: number; longitude: number; timezone: string }
export interface WeatherRequest { city: string | null; place: WeatherPlace | null; date: string | null }
export interface WeatherReport {
  place: WeatherPlace; referenceTime: string; timezone: string; retrievedAt: string;
  forecastDate: string | null; weatherCode: number; temperature: number | null; apparentTemperature: number | null;
  precipitation: number; minimum: number | null; maximum: number | null; rainProbability: number | null;
}
export type WeatherResult = { status: 'choose'; choices: WeatherPlace[] } | { status: 'ready'; report: WeatherReport };
export type WeatherTransport = (request: WeatherRequest) => Promise<WeatherResult>;
export const getWeather: WeatherTransport = request => isTauri() ? invoke('get_weather', { request }) : Promise.reject('A consulta de clima exige o aplicativo Windows.');
export const weatherSources = [
  { id: 'open-meteo', label: 'Open-Meteo', url: 'https://open-meteo.com/' },
  { id: 'license', label: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  { id: 'geonames', label: 'GeoNames', url: 'https://www.geonames.org/' },
] as const;
export const openWeatherSource = (source: typeof weatherSources[number]['id']) => isTauri()
  ? invoke<void>('open_weather_source', { source }) : Promise.reject('Fontes externas exigem o aplicativo Windows.');
export const placeLabel = (place: WeatherPlace) => [place.name, place.admin1, place.country].filter(Boolean).join(', ');

const descriptions: Record<number, string> = {
  0: 'céu limpo', 1: 'predominantemente limpo', 2: 'parcialmente nublado', 3: 'encoberto', 45: 'nevoeiro', 48: 'nevoeiro com geada',
  51: 'garoa leve', 53: 'garoa moderada', 55: 'garoa intensa', 56: 'garoa congelante leve', 57: 'garoa congelante intensa',
  61: 'chuva leve', 63: 'chuva moderada', 65: 'chuva forte', 66: 'chuva congelante leve', 67: 'chuva congelante forte',
  71: 'neve leve', 73: 'neve moderada', 75: 'neve intensa', 77: 'grãos de neve', 80: 'pancadas leves de chuva', 81: 'pancadas moderadas de chuva',
  82: 'pancadas fortes de chuva', 85: 'pancadas leves de neve', 86: 'pancadas fortes de neve', 95: 'trovoadas', 96: 'trovoadas com granizo leve', 99: 'trovoadas com granizo forte',
};
const number = (value: number) => value.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
export function weatherText(report: WeatherReport): string {
  const description = descriptions[report.weatherCode];
  if (!description || !Number.isFinite(report.precipitation)) throw new Error('Incomplete weather report');
  const date = report.forecastDate?.split('-').reverse().join('/');
  const details = report.forecastDate
    ? `Previsão para ${date}: ${description}. Mínima de ${number(report.minimum!)} °C e máxima de ${number(report.maximum!)} °C. Probabilidade máxima de precipitação: ${number(report.rainProbability!)}%; acumulado previsto: ${number(report.precipitation)} mm.`
    : `Condições atuais estimadas: ${description}, ${number(report.temperature!)} °C, sensação de ${number(report.apparentTemperature!)} °C. Precipitação no intervalo do provedor: ${number(report.precipitation)} mm.`;
  return `${placeLabel(report.place)}, senhor.\n${details}\nReferência do provedor: ${report.referenceTime.replace('T', ' ')} (${report.timezone}). Consulta: ${report.retrievedAt}.\nDados de modelos meteorológicos; descrição traduzida e valores formatados pelo JARVIS. Fonte: Open-Meteo, CC BY 4.0. Localidades: GeoNames.`;
}
