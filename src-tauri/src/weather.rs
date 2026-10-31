//! On-demand public weather data. Fixed HTTPS providers; no key or task store.
//! Sources: https://open-meteo.com/en/docs and /en/docs/geocoding-api
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, Utc};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const INVALID: &str = "A Open-Meteo não retornou dados meteorológicos suficientes e válidos.";
const UNAVAILABLE: &str = "A Open-Meteo está indisponível ou excedeu o tempo de resposta.";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Place {
    pub id: i64,
    pub name: String,
    pub admin1: String,
    pub country: String,
    pub latitude: f64,
    pub longitude: f64,
    pub timezone: String,
}
impl Place {
    fn validate(&self) -> Result<(), &'static str> {
        if self.id <= 0
            || !text(&self.name, 100)
            || !text(&self.country, 100)
            || self.admin1.chars().count() > 100
            || self.admin1.chars().any(char::is_control)
            || !text(&self.timezone, 100)
            || !self.latitude.is_finite()
            || !self.longitude.is_finite()
            || !(-90.0..=90.0).contains(&self.latitude)
            || !(-180.0..=180.0).contains(&self.longitude)
        {
            return Err(INVALID);
        }
        Ok(())
    }
}
fn text(s: &str, limit: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= limit && !s.chars().any(char::is_control)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub city: Option<String>,
    pub place: Option<Place>,
    pub date: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub place: Place,
    pub reference_time: String,
    pub timezone: String,
    pub retrieved_at: String,
    pub forecast_date: Option<String>,
    pub weather_code: i64,
    pub temperature: Option<f64>,
    pub apparent_temperature: Option<f64>,
    pub precipitation: f64,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub rain_probability: Option<f64>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResultData {
    Choose { choices: Vec<Place> },
    Ready { report: Report },
}

pub fn geocoding_url(city: &str) -> Result<Url, &'static str> {
    if !text(city, 150) || city.trim().chars().count() < 2 {
        return Err("Informe a cidade e, se necessário, estado ou país.");
    }
    let mut url =
        Url::parse("https://geocoding-api.open-meteo.com/v1/search").map_err(|_| INVALID)?;
    url.query_pairs_mut()
        .append_pair("name", city.trim())
        .append_pair("count", "10")
        .append_pair("language", "pt");
    Ok(url)
}
pub fn forecast_url(place: &Place) -> Result<Url, &'static str> {
    place.validate()?;
    let mut url = Url::parse("https://api.open-meteo.com/v1/forecast").map_err(|_| INVALID)?;
    url.query_pairs_mut().append_pair("latitude", &place.latitude.to_string())
        .append_pair("longitude", &place.longitude.to_string()).append_pair("timezone", "auto")
        .append_pair("forecast_days", "16")
        .append_pair("current", "temperature_2m,apparent_temperature,precipitation,weather_code")
        .append_pair("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max");
    Ok(url)
}
pub fn parse_places(value: &Value) -> Result<Vec<Place>, &'static str> {
    if value.get("error").is_some() {
        return Err(INVALID);
    }
    let Some(results) = value.get("results") else {
        if value.is_object() {
            return Ok(vec![]);
        } else {
            return Err(INVALID);
        }
    };
    let records = results
        .as_array()
        .filter(|r| r.len() <= 10)
        .ok_or(INVALID)?;
    let mut places: Vec<Place> = vec![];
    for record in records {
        if !record["feature_code"]
            .as_str()
            .is_some_and(|s| s.starts_with("PPL"))
        {
            continue;
        }
        let place = Place {
            id: record["id"].as_i64().ok_or(INVALID)?,
            name: record["name"].as_str().ok_or(INVALID)?.into(),
            admin1: record
                .get("admin1")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            country: record["country"].as_str().ok_or(INVALID)?.into(),
            latitude: record["latitude"].as_f64().ok_or(INVALID)?,
            longitude: record["longitude"].as_f64().ok_or(INVALID)?,
            timezone: record["timezone"].as_str().ok_or(INVALID)?.into(),
        };
        place.validate()?;
        if !places.iter().any(|p| p.id == place.id) {
            places.push(place);
        }
    }
    Ok(places)
}
fn number(value: &Value, low: f64, high: f64) -> Result<f64, &'static str> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && (low..=high).contains(n))
        .ok_or(INVALID)
}
fn code(value: &Value) -> Result<i64, &'static str> {
    value
        .as_i64()
        .filter(|n| {
            [
                0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81,
                82, 85, 86, 95, 96, 99,
            ]
            .contains(n)
        })
        .ok_or(INVALID)
}
fn date_request(date: Option<&str>, now: DateTime<Utc>) -> Result<Option<NaiveDate>, &'static str> {
    date.map(|d| {
        let date = NaiveDate::parse_from_str(d, "%Y-%m-%d")
            .map_err(|_| "Informe uma data válida para a previsão.")?;
        let days = (date - now.date_naive()).num_days();
        if d.len() != 10 || !(-1..=16).contains(&days) {
            return Err("Consulte uma data dentro dos próximos 16 dias.");
        }
        Ok(date)
    })
    .transpose()
}
pub fn parse_forecast(
    value: &Value,
    place: Place,
    date: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Report, &'static str> {
    place.validate()?;
    let requested = date_request(date, now)?;
    let zone = value["timezone"]
        .as_str()
        .filter(|z| text(z, 100))
        .ok_or(INVALID)?;
    let offset = value["utc_offset_seconds"]
        .as_i64()
        .and_then(|n| i32::try_from(n).ok())
        .and_then(FixedOffset::east_opt)
        .ok_or(INVALID)?;
    let reference = value["current"]["time"].as_str().ok_or(INVALID)?;
    let reference_local = NaiveDateTime::parse_from_str(reference, "%Y-%m-%dT%H:%M")
        .or_else(|_| NaiveDateTime::parse_from_str(reference, "%Y-%m-%dT%H:%M:%S"))
        .map_err(|_| INVALID)?;
    let reference_utc = reference_local
        .and_local_timezone(offset)
        .single()
        .ok_or(INVALID)?
        .with_timezone(&Utc);
    if (now - reference_utc).num_seconds() > 3 * 3600
        || (reference_utc - now).num_seconds() > 15 * 60
    {
        return Err("A Open-Meteo retornou uma referência meteorológica desatualizada.");
    }
    let mut report = Report {
        place,
        reference_time: reference.into(),
        timezone: zone.into(),
        retrieved_at: now.to_rfc3339(),
        forecast_date: date.map(str::to_string),
        weather_code: 0,
        temperature: None,
        apparent_temperature: None,
        precipitation: 0.0,
        minimum: None,
        maximum: None,
        rain_probability: None,
    };
    if let Some(date) = requested {
        let today = now.with_timezone(&offset).date_naive();
        if date < today || (date - today).num_days() > 15 {
            return Err("Consulte uma data dentro dos próximos 16 dias.");
        }
        let daily = &value["daily"];
        let times = daily["time"]
            .as_array()
            .filter(|a| a.len() <= 16)
            .ok_or(INVALID)?;
        let index = times
            .iter()
            .position(|v| v.as_str() == Some(&date.to_string()))
            .ok_or(INVALID)?;
        for field in [
            "weather_code",
            "temperature_2m_max",
            "temperature_2m_min",
            "precipitation_sum",
            "precipitation_probability_max",
        ] {
            if daily[field]
                .as_array()
                .is_none_or(|a| a.len() != times.len())
            {
                return Err(INVALID);
            }
        }
        if value["daily_units"]["temperature_2m_max"] != "°C"
            || value["daily_units"]["temperature_2m_min"] != "°C"
            || value["daily_units"]["precipitation_sum"] != "mm"
            || value["daily_units"]["precipitation_probability_max"] != "%"
        {
            return Err(INVALID);
        }
        report.weather_code = code(&daily["weather_code"][index])?;
        report.minimum = Some(number(&daily["temperature_2m_min"][index], -100.0, 70.0)?);
        report.maximum = Some(number(&daily["temperature_2m_max"][index], -100.0, 70.0)?);
        if report.minimum > report.maximum {
            return Err(INVALID);
        }
        report.precipitation = number(&daily["precipitation_sum"][index], 0.0, 3000.0)?;
        report.rain_probability = Some(number(
            &daily["precipitation_probability_max"][index],
            0.0,
            100.0,
        )?);
    } else {
        let current = &value["current"];
        if value["current_units"]["temperature_2m"] != "°C"
            || value["current_units"]["apparent_temperature"] != "°C"
            || value["current_units"]["precipitation"] != "mm"
        {
            return Err(INVALID);
        }
        report.weather_code = code(&current["weather_code"])?;
        report.temperature = Some(number(&current["temperature_2m"], -100.0, 70.0)?);
        report.apparent_temperature = Some(number(&current["apparent_temperature"], -100.0, 80.0)?);
        report.precipitation = number(&current["precipitation"], 0.0, 3000.0)?;
    }
    Ok(report)
}

async fn fetch(client: &Client, url: Url) -> Result<Value, &'static str> {
    let mut response = client.get(url).send().await.map_err(|_| UNAVAILABLE)?;
    if !response.status().is_success() {
        return Err(UNAVAILABLE);
    }
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if bytes.len() + chunk.len() > 131072 {
            return Err(INVALID);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| INVALID)
}
pub async fn get_weather(request: Request) -> Result<ResultData, &'static str> {
    date_request(request.date.as_deref(), Utc::now())?;
    if request.city.is_some() == request.place.is_some() {
        return Err("Informe uma cidade ou escolha uma localidade já apresentada.");
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| UNAVAILABLE)?;
    let place = if let Some(place) = request.place {
        place.validate()?;
        place
    } else {
        let url = geocoding_url(request.city.as_deref().ok_or(INVALID)?)?;
        let mut places = parse_places(&fetch(&client, url).await?)?;
        if places.is_empty() {
            return Err("Não encontrei essa cidade. Informe também o estado ou país, senhor.");
        }
        if places.len() != 1 {
            return Ok(ResultData::Choose { choices: places });
        }
        places.remove(0)
    };
    let value = fetch(&client, forecast_url(&place)?).await?;
    Ok(ResultData::Ready {
        report: parse_forecast(&value, place, request.date.as_deref(), Utc::now())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn place() -> Place {
        Place {
            id: 1,
            name: "Cidade fictícia".into(),
            admin1: "Minas Gerais".into(),
            country: "Brasil".into(),
            latitude: -19.9,
            longitude: -43.9,
            timezone: "America/Sao_Paulo".into(),
        }
    }
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-24T15:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }
    fn fixture() -> Value {
        json!({"timezone":"America/Sao_Paulo","utc_offset_seconds":-10800,
        "current":{"time":"2026-10-24T12:00","temperature_2m":25.5,"apparent_temperature":26.0,"precipitation":0.1,"weather_code":2},
        "current_units":{"temperature_2m":"°C","apparent_temperature":"°C","precipitation":"mm"},
        "daily":{"time":["2026-10-25"],"weather_code":[61],"temperature_2m_max":[28.0],"temperature_2m_min":[19.0],"precipitation_sum":[3.5],"precipitation_probability_max":[80]},
        "daily_units":{"temperature_2m_max":"°C","temperature_2m_min":"°C","precipitation_sum":"mm","precipitation_probability_max":"%"}})
    }
    #[test]
    fn reads_current_provider_values_and_reference() {
        let report = parse_forecast(&fixture(), place(), None, now()).unwrap();
        assert_eq!(report.temperature, Some(25.5));
        assert_eq!(report.reference_time, "2026-10-24T12:00");
        assert_eq!(report.precipitation, 0.1);
    }
    #[test]
    fn reads_daily_values_without_predicting_rain_from_prose() {
        let report = parse_forecast(&fixture(), place(), Some("2026-10-25"), now()).unwrap();
        assert_eq!(report.rain_probability, Some(80.0));
        assert_eq!(report.minimum, Some(19.0));
        assert!(report.temperature.is_none());
    }
    #[test]
    fn missing_null_wrong_units_and_out_of_range_values_are_unavailable() {
        for (field, val) in [
            ("temperature_2m", Value::Null),
            ("temperature_2m", json!(200)),
            ("precipitation", json!(-1)),
            ("weather_code", json!(123)),
        ] {
            let mut f = fixture();
            f["current"][field] = val;
            assert!(parse_forecast(&f, place(), None, now()).is_err());
        }
        let mut f = fixture();
        f["current_units"]["temperature_2m"] = json!("°F");
        assert!(parse_forecast(&f, place(), None, now()).is_err());
        let mut f = fixture();
        f["daily"]["precipitation_probability_max"] = json!([]);
        assert!(parse_forecast(&f, place(), Some("2026-10-25"), now()).is_err());
    }
    #[test]
    fn refuses_stale_data_invalid_dates_and_missing_target_day() {
        assert!(parse_forecast(
            &fixture(),
            place(),
            None,
            now() + chrono::Duration::hours(4)
        )
        .is_err());
        for date in ["2026-02-30", "2026-10-23", "2026-12-01", "2026-10-26"] {
            assert!(parse_forecast(&fixture(), place(), Some(date), now()).is_err());
        }
    }
    #[test]
    fn urls_have_fixed_https_origins_and_encoded_user_values() {
        let url = geocoding_url("Cidade &name=x#fragment").unwrap();
        assert_eq!(url.host_str(), Some("geocoding-api.open-meteo.com"));
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "name").unwrap().1,
            "Cidade &name=x#fragment"
        );
        let url = forecast_url(&place()).unwrap();
        assert_eq!(url.host_str(), Some("api.open-meteo.com"));
        assert_eq!(url.scheme(), "https");
        let mut p = place();
        p.latitude = f64::NAN;
        assert!(forecast_url(&p).is_err());
        assert!(geocoding_url("x\0").is_err());
    }
    #[test]
    fn geocoding_preserves_ambiguity_and_does_not_select_by_population() {
        let row = json!({"id":1,"name":"Cidade","admin1":"Estado","country":"Brasil","latitude":-20,"longitude":-40,"timezone":"America/Sao_Paulo","feature_code":"PPLA"});
        let mut second = row.clone();
        second["id"] = json!(2);
        second["admin1"] = json!("Outro estado");
        assert_eq!(
            parse_places(&json!({"results":[row,second]}))
                .unwrap()
                .len(),
            2
        );
        assert!(parse_places(&json!({})).unwrap().is_empty());
        assert!(parse_places(&json!({"results":[{"id":1,"feature_code":"PPLA"}]})).is_err());
    }
}
