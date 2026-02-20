import { pgTable, serial, timestamp, varchar, integer, text } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { createSchemaFactory } from "drizzle-zod"
import { z } from "zod"

export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// 俄罗斯方块玩家表
export const tetrisPlayers = pgTable("tetris_players", {
	id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
	position: varchar("position", { length: 10 }).notNull().unique(), // 'left' 或 'right'
	playerName: varchar("player_name", { length: 100 }), // 玩家名称
	highScore: integer("high_score").notNull().default(0), // 最高分
	totalLinesCleared: integer("total_lines_cleared").notNull().default(0), // 总消除行数
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
});

// Zod schemas for validation
const { createInsertSchema: createCoercedInsertSchema } = createSchemaFactory({
	coerce: { date: true },
});

export const insertTetrisPlayerSchema = createCoercedInsertSchema(tetrisPlayers).pick({
	position: true,
	playerName: true,
	highScore: true,
	totalLinesCleared: true,
});

export const updateTetrisPlayerSchema = createCoercedInsertSchema(tetrisPlayers)
	.pick({
		playerName: true,
		highScore: true,
		totalLinesCleared: true,
	})
	.partial();

// TypeScript types
export type TetrisPlayer = typeof tetrisPlayers.$inferSelect;
export type InsertTetrisPlayer = z.infer<typeof insertTetrisPlayerSchema>;
export type UpdateTetrisPlayer = z.infer<typeof updateTetrisPlayerSchema>;
