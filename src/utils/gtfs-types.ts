enum CalendarDateException {
    ADDED = 1,
    REMOVED = 2
}

enum RouteType {
    BUS = 3
}

enum LocationType {
    STOP_OR_PLATFORM = 0,
    STATION = 1
}

interface CalendarDate {
    service_id: string,
    date: string,
    exception_type: number
}

interface Calendar {
    service_id: string,
    monday: number,
    tuesday: number,
    wednesday: number,
    thursday: number,
    friday: number,
    saturday: number,
    sunday: number,
    start_date: string,
    end_date: string
}

interface Trip {
    trip_id: string,
    route_id: string,
    service_id: string,
    trip_headsign: string,
    trip_short_name: string,
    direction_id: number,
    shape_id: string,
    wheelchair_accessible: number,
    bikes_allowed: number
}

interface StopTime {
    trip_id: string,
    arrival_time: string,
    departure_time: string,
    stop_id: string,
    stop_sequence: number,
    stop_headsign: string,
    pickup_type: number,
    drop_off_type: number,
    continuous_pickup: number,
    continuous_drop_off: number,
    shape_dist_traveled: number,
    timepoint: number
}

interface Stop {
    stop_id: string,
    stop_code: string,
    stop_name: string,
    stop_desc: string,
    stop_lat: number,
    stop_lon: number,
    zone_id: number | string,
    parent_station: string,
    location_type: string | number,
    stop_timezone: string,
    wheelchair_boarding: number,
    platform_code: string,
    stop_digiroad_id: string,
    stop_digiroad_name: string,
    stop_mh_id: string,
    stop_osm_ref: string,
    stop_osm_findr: string,
    stop_vr_id: string,
    stop_ob_id: string,
    stop_cluster_id: string,
    merged_to_gtfs_id: number | undefined,
    merged_to_stop_id: string
    merged_stop: Stop | undefined,
    meta: StopMeta | undefined,
    vehicle_type?: string // HSL data has this (same values used as in gtfs spec route_type)
    digistop_id?: string // Matkahuolto
    municipality_code?: string // Matkahuolto
}

interface StopMeta {
    code?: { [key: string]: string },
    name?: LocalizedProviderStrings,
    notes?: LocalizedProviderStringLists | undefined,
    zones?: ProviderStrings | undefined,
    extra?: ExtraStrings | undefined
}

interface LocalizedString {
    [key: string]: string | undefined,
    // fi?: string | undefined,
    // sv?: string | undefined,
    // en?: string | undefined,
    // de?: string | undefined,
    // bg?: string | undefined,
    // hr?: string | undefined
}

interface LocalizedProviderStrings {
    [key: string]: LocalizedString | undefined,
}

interface LocalizedProviderStringLists {
    [key: string]: LocalizedString[] | undefined,
}

interface ProviderStrings {
    [key: string]: string | undefined,
}

interface ExtraStrings {
    [key: string]: string | undefined,
}

interface Route {
    route_id: string,
    agency_id: string,
    route_short_name: string,
    route_long_name: string,
    route_desc: string,
    route_type: RouteType
    route_url: string,
}

interface Agency {
    agency_id: string,
    agency_name: string,
    agency_url: string,
    agency_timezone: string,
    agency_lang: string,
    agency_phone: string,
    agency_fare_url: string,
    agency_email: string
}

interface FeedInfo {
    feed_publisher_name: string,
    feed_publisher_url: string,
    feed_lang: string,
    default_lang?: string,
    feed_start_date?: string,
    feed_end_date?: string,
    feed_version?: string,
    feed_contact_email?: string,
    feed_contact_url?: string
}

interface Shape {
    shape_id: string,
    shape_pt_lat: number,
    shape_pt_lon: number,
    shape_pt_sequence: number,
    shape_dist_traveled?: number,
}

interface Translation {
    table_name: string,
    field_name: string,
    language: string,
    translation: string,
    record_id?: string,
    record_sub_id?: string,
    field_value?: string
}

interface Gtfs {
    gtfs_id: number | undefined,
    name: string,
    agency: Agency[],
    routes: Route[],
    stops: Stop[],
    calendar: Calendar[],
    calendar_dates: CalendarDate[],
    stop_times: StopTime[],
    trips: Trip[],
    shapes?: { [key: string]: Shape[] },
    translations?: Translation[],
    feed_info?: FeedInfo[], // array for now so write-gtfs works, remember to have only one element though
}

function isDefined<T>(argument: T | undefined): argument is T {
    return argument !== undefined
}

export {
    Agency,
    FeedInfo,
    Calendar,
    CalendarDate,
    CalendarDateException,
    Gtfs,
    LocalizedProviderStringLists,
    LocalizedProviderStrings,
    LocalizedString,
    LocationType,
    ProviderStrings,
    Route,
    RouteType,
    Stop,
    StopMeta,
    StopTime,
    Trip,
    Shape,
    Translation,
    isDefined
}
