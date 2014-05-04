# Copyright 2013, 2014 Kevin Reid <kpreid@switchb.org>
# 
# This file is part of ShinySDR.
# 
# ShinySDR is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
# 
# ShinySDR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.


'''
Type definitions for ShinySDR value cells; "type" in the sense of "set of values", plus coercion and other hints.
'''


from __future__ import absolute_import, division


import bisect
import math


def type_to_json(t):
	if isinstance(t, ValueType):
		return t.type_to_json()
	elif t is bool:  # TODO can we generalize this?
		return u'boolean'
	else:
		return None


class ValueType(object):
	def type_to_json(self):
		raise NotImplementedError()
	
	def __call__(self, specimen):
		raise NotImplementedError()


class Enum(ValueType):
	def __init__(self, values, strict=False, base_type=unicode):
		"""values: dict of {value: description}"""
		self.__values = dict(values)  # paranoid copy
		self.__strict = bool(strict)
		self.__base_type = base_type
	
	def values(self):
		return self.__values
	
	def type_to_json(self):
		return {'type': 'enum', 'values': self.__values}
	
	def __call__(self, specimen):
		specimen = self.__base_type(specimen)
		if specimen not in self.__values and self.__strict:
			raise ValueError('Not a permitted value: ' + repr(specimen))
		return specimen


class Range(ValueType):
	def __init__(self, subranges, strict=True, logarithmic=False, integer=False):
		# TODO validate subranges are sorted
		self.__mins = [min for (min, max) in subranges]
		self.__maxes = [max for (min, max) in subranges]
		self.__strict = strict
		self.__logarithmic = logarithmic
		self.__integer = integer
	
	def type_to_json(self):
		return {
			'type': 'range',
			'subranges': zip(self.__mins, self.__maxes),
			'logarithmic': self.__logarithmic,
			'integer': self.__integer
		}
	
	def __call__(self, specimen):
		specimen = float(specimen)
		if self.__integer:
			if self.__logarithmic:
				# We may eventually want other log base options; currently only 2
				if specimen <= 0:
					specimen = self.__mins[0]
				specimen = 2 ** int(round(math.log(specimen, 2)))
			else:
				specimen = int(round(specimen))
		if self.__strict:
			mins = self.__mins
			maxes = self.__maxes
			i = bisect.bisect_right(mins, specimen)
			if i >= len(mins): i = len(mins) - 1
			# i is now the index of the highest subrange which is not too high to contain specimen
			# TODO: Round to nearest range instead of lower one. For now, the client handles all user-visible rounding.
			if specimen < mins[i]:
				specimen = mins[i]
			if specimen > maxes[i]:
				specimen = maxes[i]
		return specimen


class Notice(ValueType):
	def __init__(self, always_visible=False):
		self.__always_visible = always_visible
	
	def type_to_json(self):
		return {
			'type': 'notice',
			'always_visible': self.__always_visible
		}
	
	def __call__(self, specimen):
		return unicode(specimen)
