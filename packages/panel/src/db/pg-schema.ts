/**
 * The Panel's Postgres schema (#567, ADR 0041 D14). Empty on purpose: the
 * baseline migration holds no tables, and each later pull request of #567 adds
 * the tables it moves here and generates its migration with `db:generate`.
 */
export {};
